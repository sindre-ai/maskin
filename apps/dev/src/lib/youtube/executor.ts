import type { Database } from '@maskin/db'
import { youtubePendingActions } from '@maskin/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { TokenManager } from '../integrations/oauth/token-manager'
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

export interface ExecutorDeps {
	client: Pick<YoutubeWriteClient, 'execute'>
	getAccessToken: (db: Database, integrationId: string) => Promise<string>
}

const defaultDeps: ExecutorDeps = {
	client: googleWriteClient,
	getAccessToken: (db, integrationId) =>
		new TokenManager().getValidToken(db, integrationId, getProvider(YOUTUBE_PROVIDER)),
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
		})
		return finish(db, row, result.ok ? 'executed' : 'failed', result.code)
	} catch (err) {
		logger.warn('YouTube action: request failed', { actionId, error: String(err) })
		return finish(db, row, 'failed', 'request_failed')
	}
}

/** Starts an approved action in the background, after the approval has committed. */
export function scheduleYoutubeExecution(db: Database, actionId: string): void {
	executeApprovedYoutubeAction(db, actionId).catch((err) =>
		logger.error('YouTube action: execution crashed', { actionId, error: String(err) }),
	)
}
