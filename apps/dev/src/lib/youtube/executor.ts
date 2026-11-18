import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { files, youtubePendingActions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { TokenManager } from '../integrations/oauth/token-manager'
import { isYoutubeError } from '../integrations/providers/youtube/errors'
import { chargeYoutubeQuota } from '../integrations/providers/youtube/quota'
import { getProvider } from '../integrations/registry'
import { logger } from '../logger'
import {
	YOUTUBE_PROVIDER,
	type YoutubeActionKind,
	type YoutubeActionRow,
	endYoutubeAction,
	writeYoutubeAudit,
} from './actions'
import { type YoutubeWriteClient, googleWriteClient } from './google-write-client'
import { hashYoutubePayload } from './hash'

/**
 * Runs approved YouTube actions. This module is the only importer of the Google write client.
 *
 * An action runs at most once: the claim is one conditional update (status approved, never
 * claimed, not expired, approved hash equals stored hash), so parallel approvals, a retry and the
 * sweep cannot all run it. A crash after the claim leaves the action claimed and unfinished; the
 * sweep marks it failed rather than run it again, because a second public write is worse than a
 * missed one.
 */

/** Every write costs 50 quota units (videos.update, thumbnails.set, playlists, comments, rate). */
export const YOUTUBE_WRITE_UNITS = 50
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

export interface ExecutorDeps {
	client: Pick<YoutubeWriteClient, 'execute'>
	getAccessToken: (db: Database, integrationId: string) => Promise<string>
	/** Charges the workspace and the shared budget. Defaults to the quota guard. */
	chargeQuota?: (db: Database, workspaceId: string, units: number) => Promise<void>
	/** Where image files are read from, for set_thumbnail. */
	storage?: StorageProvider
}

const defaultDeps: ExecutorDeps = {
	client: googleWriteClient,
	getAccessToken: (db, integrationId) =>
		new TokenManager().getValidToken(db, integrationId, getProvider(YOUTUBE_PROVIDER)),
}

const sniffImageType = (bytes: Uint8Array): 'image/png' | 'image/jpeg' | null => {
	const isPng =
		bytes.length >= 8 &&
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
	if (isPng) return 'image/png'
	return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
		? 'image/jpeg'
		: null
}

type ThumbnailLoad =
	| { ok: true; image: { bytes: Uint8Array; mimeType: string } }
	| { ok: false; code: string }

/**
 * The image a person approved for a thumbnail. The request holds the file id and the hash of its
 * bytes; the file is used only if its bytes still hash to that value, and the type is read from the
 * first bytes, so a replaced or renamed file is never sent.
 */
async function loadThumbnail(
	db: Database,
	storage: StorageProvider | undefined,
	row: YoutubeActionRow,
): Promise<ThumbnailLoad> {
	const payload = row.payload as { fileId?: unknown; contentHash?: unknown }
	if (typeof payload.fileId !== 'string' || typeof payload.contentHash !== 'string') {
		return { ok: false, code: 'bad_payload' }
	}
	const [file] = await db
		.select({ storageKey: files.storageKey, sizeBytes: files.sizeBytes })
		.from(files)
		.where(and(eq(files.id, payload.fileId), eq(files.workspaceId, row.workspaceId)))
		.limit(1)
	if (!file) return { ok: false, code: 'file_missing' }
	if (!storage) return { ok: false, code: 'storage_unavailable' }
	if (file.sizeBytes > THUMBNAIL_MAX_BYTES) return { ok: false, code: 'file_too_large' }
	const bytes = await storage.get(file.storageKey)
	if (createHash('sha256').update(bytes).digest('hex') !== payload.contentHash) {
		return { ok: false, code: 'file_changed' }
	}
	if (bytes.length > THUMBNAIL_MAX_BYTES) return { ok: false, code: 'file_too_large' }
	const mimeType = sniffImageType(bytes)
	if (!mimeType) return { ok: false, code: 'bad_image' }
	return { ok: true, image: { bytes, mimeType } }
}

export type ExecutionOutcome =
	| { ran: false }
	| { ran: true; status: 'executed' | 'failed'; resultCode: string }

async function claim(db: Database, actionId: string): Promise<YoutubeActionRow | undefined> {
	const [claimed] = await db
		.update(youtubePendingActions)
		.set({ claimedAt: new Date() })
		.where(
			and(
				eq(youtubePendingActions.id, actionId),
				eq(youtubePendingActions.status, 'approved'),
				isNull(youtubePendingActions.claimedAt),
				sql`${youtubePendingActions.expiresAt} > now()`,
				sql`${youtubePendingActions.approvedPayloadHash} = ${youtubePendingActions.payloadHash}`,
			),
		)
		.returning()
	return claimed
}

async function finish(
	db: Database,
	row: YoutubeActionRow,
	status: 'executed' | 'failed',
	resultCode: string,
): Promise<ExecutionOutcome> {
	await endYoutubeAction(db, row, { status, resultCode })
	await writeYoutubeAudit(db, row, { decision: status, actorId: null, resultCode })
	return { ran: true, status, resultCode }
}

/** Runs one approved action if it can still run. Returns `{ ran: false }` when something else has it. */
export async function executeApprovedYoutubeAction(
	db: Database,
	actionId: string,
	deps: ExecutorDeps = defaultDeps,
): Promise<ExecutionOutcome> {
	const row = await claim(db, actionId)
	if (!row) return { ran: false }

	// The request must still be the one the person approved.
	if (row.payload === null || hashYoutubePayload(row.payload) !== row.approvedPayloadHash) {
		return finish(db, row, 'failed', 'payload_changed')
	}

	// Charged now, when it runs, and not refunded if Google refuses: the same rule as every read.
	try {
		await (deps.chargeQuota ?? chargeYoutubeQuota)(db, row.workspaceId, YOUTUBE_WRITE_UNITS)
	} catch (err) {
		if (isYoutubeError(err)) return finish(db, row, 'failed', 'quota_exhausted')
		logger.warn('YouTube action: quota charge failed', { actionId, error: String(err) })
		return finish(db, row, 'failed', 'request_failed')
	}

	let image: { bytes: Uint8Array; mimeType: string } | undefined
	if (row.kind === 'set_thumbnail') {
		try {
			const loaded = await loadThumbnail(db, deps.storage, row)
			if (!loaded.ok) return finish(db, row, 'failed', loaded.code)
			image = loaded.image
		} catch (err) {
			logger.warn('YouTube action: thumbnail could not be read', { actionId, error: String(err) })
			return finish(db, row, 'failed', 'request_failed')
		}
	}

	let accessToken: string
	try {
		accessToken = await deps.getAccessToken(db, row.integrationId)
	} catch (err) {
		logger.warn('YouTube action: no access token', { actionId, error: String(err) })
		return finish(db, row, 'failed', 'auth_failed')
	}

	try {
		const result = await deps.client.execute({
			kind: row.kind as YoutubeActionKind,
			payload: row.payload as Record<string, unknown>,
			accessToken,
			...(image ? { image } : {}),
		})
		return finish(db, row, result.ok ? 'executed' : 'failed', result.code)
	} catch (err) {
		logger.warn('YouTube action: request failed', { actionId, error: String(err) })
		return finish(db, row, 'failed', 'request_failed')
	}
}

/** Starts an approved action in the background, after the approval has committed. */
export function scheduleYoutubeExecution(
	db: Database,
	actionId: string,
	storage?: StorageProvider,
): void {
	executeApprovedYoutubeAction(db, actionId, { ...defaultDeps, storage }).catch((err) =>
		logger.error('YouTube action: execution crashed', { actionId, error: String(err) }),
	)
}
