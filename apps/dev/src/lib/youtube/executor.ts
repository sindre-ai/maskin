import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { Database } from '@maskin/db'
import { files, youtubePendingActions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { TokenManager } from '../integrations/oauth/token-manager'
import { isYoutubeError } from '../integrations/providers/youtube/errors'
import {
	chargeYoutubeQuota,
	chargeYoutubeUploadQuota,
} from '../integrations/providers/youtube/quota'
import { getProvider } from '../integrations/registry'
import { logger } from '../logger'
import {
	YOUTUBE_CLAIM_STALE_MS,
	YOUTUBE_PROVIDER,
	type YoutubeActionKind,
	type YoutubeActionRow,
	endYoutubeAction,
	writeYoutubeAudit,
} from './actions'
import {
	buildInsertBody,
	publishVideo,
	startUploadSession,
	uploadFile,
} from './google-upload-client'
import { type YoutubeWriteClient, googleWriteClient } from './google-write-client'
import { hashYoutubePayload } from './hash'
import {
	type PublishPayload,
	type UploadPayload,
	YOUTUBE_UPLOAD_MAX_BYTES,
	publishTimeHasPassed,
} from './upload'

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
	/** Where files are read from: the thumbnail image and the video of an upload. */
	storage?: StorageProvider
	/** What an upload or publish talks to. Tests replace it; the default is Google and the database. */
	upload?: Partial<UploadDeps>
}

/** A stored file an upload reads from. */
export interface StoredUploadFile {
	name: string
	mimeType: string
	sizeBytes: number
	contentHash: string | null
	storageKey: string
}

export interface UploadDeps {
	startSession: typeof startUploadSession
	uploadFile: typeof uploadFile
	publishVideo: typeof publishVideo
	loadFile: (db: Database, workspaceId: string, fileId: string) => Promise<StoredUploadFile | null>
	/** Streams the file. Defaults to the executor's storage. */
	openFile?: (storageKey: string) => Promise<Readable>
	chargeUpload: (db: Database, workspaceId: string) => Promise<void>
}

const defaultUploadDeps: UploadDeps = {
	startSession: startUploadSession,
	uploadFile,
	publishVideo,
	loadFile: async (db, workspaceId, fileId) => {
		const [file] = await db
			.select({
				name: files.name,
				mimeType: files.mimeType,
				sizeBytes: files.sizeBytes,
				contentHash: files.contentHash,
				storageKey: files.storageKey,
			})
			.from(files)
			.where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)))
			.limit(1)
		return file ?? null
	},
	chargeUpload: (db, workspaceId) => chargeYoutubeUploadQuota(db, workspaceId),
}

/** An upload that is cut off this many times stops, so a file that cannot finish does not retry for ever. */
export const YOUTUBE_UPLOAD_MAX_RUNS = 5
/** videos.list (1) plus videos.update (50). */
const PUBLISH_QUOTA_UNITS = 51

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
	| { ran: true; status: 'executed' | 'failed' | 'interrupted'; resultCode: string }

async function claim(db: Database, actionId: string): Promise<YoutubeActionRow | undefined> {
	const [claimed] = await db
		.update(youtubePendingActions)
		.set({
			claimedAt: new Date(),
			uploadAttempts: sql`${youtubePendingActions.uploadAttempts} + 1`,
		})
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
	return runClaimed(db, row, deps)
}

async function runClaimed(
	db: Database,
	row: YoutubeActionRow,
	deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
	const actionId = row.id
	// The request must still be the one the person approved.
	if (row.payload === null || hashYoutubePayload(row.payload) !== row.approvedPayloadHash) {
		return finish(db, row, 'failed', 'payload_changed')
	}

	// An upload and a publish have their own budgets and their own steps (below).
	if (row.kind === 'upload_video') return runUpload(db, row, deps)
	if (row.kind === 'publish_video') return runPublish(db, row, deps)

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

async function runPublish(
	db: Database,
	row: YoutubeActionRow,
	deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
	const up = { ...defaultUploadDeps, ...deps.upload }
	const payload = row.payload as unknown as PublishPayload
	// A time that went by while the request waited would publish the video at once: do not send it.
	if (publishTimeHasPassed(payload)) return finish(db, row, 'failed', 'publish_time_passed')
	try {
		await (deps.chargeQuota ?? chargeYoutubeQuota)(db, row.workspaceId, PUBLISH_QUOTA_UNITS)
	} catch {
		return finish(db, row, 'failed', 'quota_exhausted')
	}
	let accessToken: string
	try {
		accessToken = await deps.getAccessToken(db, row.integrationId)
	} catch (err) {
		logger.warn('YouTube action: no access token', { actionId: row.id, error: String(err) })
		return finish(db, row, 'failed', 'auth_failed')
	}
	try {
		const result = await up.publishVideo({ accessToken, payload })
		return finish(db, row, result.ok ? 'executed' : 'failed', result.ok ? 'ok' : result.code)
	} catch (err) {
		logger.warn('YouTube action: publish failed', { actionId: row.id, error: String(err) })
		return finish(db, row, 'failed', 'request_failed')
	}
}

/**
 * Uploads the stored file as a private video. The upload is a resumable session: the address and
 * the confirmed byte count are written back to the row, so a run that is cut off carries on from
 * what Google holds (see `resumeInterruptedYoutubeUploads`). Privacy is set to private by the
 * upload client whatever the request held.
 */
async function runUpload(
	db: Database,
	row: YoutubeActionRow,
	deps: ExecutorDeps,
): Promise<ExecutionOutcome> {
	const payload = row.payload as unknown as UploadPayload
	const up = { ...defaultUploadDeps, ...deps.upload }

	if (!up.openFile && !deps.storage) return finish(db, row, 'failed', 'storage_unavailable')
	const file = await up.loadFile(db, row.workspaceId, payload.fileId)
	if (!file) return finish(db, row, 'failed', 'file_missing')
	// The file must still be the one the person approved.
	if (
		file.sizeBytes !== payload.sizeBytes ||
		(payload.contentHash !== undefined && file.contentHash !== payload.contentHash)
	) {
		return finish(db, row, 'failed', 'file_changed')
	}
	if (file.sizeBytes > YOUTUBE_UPLOAD_MAX_BYTES) return finish(db, row, 'failed', 'file_too_large')

	const getAccessToken = () => deps.getAccessToken(db, row.integrationId)
	let sessionUri = row.uploadSessionUri
	if (!sessionUri) {
		try {
			await up.chargeUpload(db, row.workspaceId)
		} catch {
			return finish(db, row, 'failed', 'quota_exhausted')
		}
		let token: string
		try {
			token = await getAccessToken()
		} catch {
			return finish(db, row, 'failed', 'auth_failed')
		}
		const started = await up.startSession({
			accessToken: token,
			body: buildInsertBody(payload),
			sizeBytes: file.sizeBytes,
			mimeType: file.mimeType,
		})
		if (!started.ok) {
			return started.retryable && row.uploadAttempts < YOUTUBE_UPLOAD_MAX_RUNS
				? { ran: true, status: 'interrupted', resultCode: started.code }
				: finish(db, row, 'failed', started.code)
		}
		sessionUri = started.sessionUri
		await db
			.update(youtubePendingActions)
			.set({ uploadSessionUri: sessionUri, uploadBytesSent: 0, claimedAt: new Date() })
			.where(eq(youtubePendingActions.id, row.id))
	}

	let result: Awaited<ReturnType<UploadDeps['uploadFile']>>
	try {
		result = await up.uploadFile({
			sessionUri,
			getAccessToken,
			totalBytes: file.sizeBytes,
			openFile: () => openVideo(up, deps.storage, file.storageKey),
			// Each confirmed chunk is also the sign of life the sweep reads, so a long upload is never mistaken for a stuck one.
			onProgress: async (bytesSent) => {
				await db
					.update(youtubePendingActions)
					.set({ uploadBytesSent: bytesSent, claimedAt: new Date() })
					.where(eq(youtubePendingActions.id, row.id))
					.catch((err) =>
						logger.warn('YouTube upload: could not store progress', {
							actionId: row.id,
							error: String(err),
						}),
					)
			},
		})
	} catch (err) {
		logger.warn('YouTube upload: crashed', { actionId: row.id, error: String(err) })
		result = { state: 'interrupted' }
	}

	if (result.state === 'done') {
		await db
			.update(youtubePendingActions)
			.set({ targetVideoId: result.videoId })
			.where(eq(youtubePendingActions.id, row.id))
		return finish(db, row, 'executed', 'ok')
	}
	if (result.state === 'failed') return finish(db, row, 'failed', result.code)
	if (row.uploadAttempts >= YOUTUBE_UPLOAD_MAX_RUNS) {
		return finish(db, row, 'failed', 'upload_failed')
	}
	// Cut off: leave the row claimed with its progress. The sweep resumes it once it has been quiet for a while.
	return { ran: true, status: 'interrupted', resultCode: 'interrupted' }
}

/**
 * Picks up uploads that were cut off (a restart, a dropped connection) and carries them on from
 * the stored session. Only an upload that has a session address and has been quiet for the stale
 * window is touched, and the claim is one conditional update, so two sweeps cannot both resume it.
 * Each upload carries on in the background; this returns how many it started.
 */
export async function resumeInterruptedYoutubeUploads(
	db: Database,
	opts: {
		/** Where the video is read from. */
		storage?: StorageProvider
		deps?: ExecutorDeps
		/** Wait for the resumed uploads to end. Only tests do: the sweep must not sit through an upload. */
		wait?: boolean
	} = {},
): Promise<number> {
	const deps = opts.deps ?? { ...defaultDeps, storage: opts.storage }
	const quiet = new Date(Date.now() - YOUTUBE_CLAIM_STALE_MS)
	const candidates = await db
		.select({ id: youtubePendingActions.id, claimedAt: youtubePendingActions.claimedAt })
		.from(youtubePendingActions)
		.where(
			and(
				eq(youtubePendingActions.kind, 'upload_video'),
				eq(youtubePendingActions.status, 'approved'),
				isNotNull(youtubePendingActions.uploadSessionUri),
				lt(youtubePendingActions.claimedAt, quiet),
			),
		)
	let resumed = 0
	const running: Promise<unknown>[] = []
	for (const candidate of candidates) {
		if (!candidate.claimedAt) continue
		const [row] = await db
			.update(youtubePendingActions)
			.set({
				claimedAt: new Date(),
				uploadAttempts: sql`${youtubePendingActions.uploadAttempts} + 1`,
			})
			.where(
				and(
					eq(youtubePendingActions.id, candidate.id),
					eq(youtubePendingActions.status, 'approved'),
					eq(youtubePendingActions.claimedAt, candidate.claimedAt),
					sql`${youtubePendingActions.expiresAt} > now()`,
					sql`${youtubePendingActions.approvedPayloadHash} = ${youtubePendingActions.payloadHash}`,
				),
			)
			.returning()
		if (!row) continue
		resumed++
		running.push(
			runClaimed(db, row, deps).catch((err) =>
				logger.error('YouTube upload: resume crashed', { actionId: row.id, error: String(err) }),
			),
		)
	}
	if (opts.wait) await Promise.all(running)
	return resumed
}

function openVideo(
	up: UploadDeps,
	storage: StorageProvider | undefined,
	storageKey: string,
): Promise<Readable> {
	if (up.openFile) return up.openFile(storageKey)
	if (!storage) throw new Error('No file storage is configured for YouTube uploads')
	// Streamed, never read into memory whole.
	return storage.getStream(storageKey)
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
