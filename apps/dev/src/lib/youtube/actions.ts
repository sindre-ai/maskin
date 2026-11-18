import type { Database, Transaction } from '@maskin/db'
import { integrations, youtubeActionAudit, youtubePendingActions } from '@maskin/db/schema'
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import {
	type YoutubeActionKind as TrackedActionKind,
	trackYoutubeActionDecided,
} from '../analytics/youtube-events'
import { postYoutubeActionCard } from './card'
import { canonicalJson, hashYoutubePayload } from './hash'

/**
 * The approval gate for every YouTube write.
 *
 * A write tool never calls Google. It calls `createPendingAction`, which stores the exact request
 * and draws a For You card from the stored row. A person's tap (or `POST
 * /api/youtube/actions/:id/decision`) calls `decideYoutubeAction`; only an approved row can be
 * claimed by the executor (`executor.ts`), which is the one module that imports the Google write
 * client. Every decision writes an audit row of ids and codes.
 */

export const YOUTUBE_ACTION_KINDS = [
	'update_video_metadata',
	'set_thumbnail',
	'create_playlist',
	'add_to_playlist',
	'post_comment',
	'reply_to_comment',
	'like',
] as const
export type YoutubeActionKind = (typeof YOUTUBE_ACTION_KINDS)[number]

export const YOUTUBE_PROVIDER = 'youtube'
/** How long an action waits for a person before it expires. */
export const YOUTUBE_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A claimed action with no result after this long is marked failed by the sweep. */
export const YOUTUBE_CLAIM_STALE_MS = 15 * 60 * 1000
/** An ended action keeps no payload; its row goes after this. */
export const YOUTUBE_ACTION_ROW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** The decision audit is kept for 12 months. */
export const YOUTUBE_AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
export const YOUTUBE_PAYLOAD_MAX_CHARS = 8_000
export const YOUTUBE_NOTE_MAX_CHARS = 1_000

export type YoutubeActionRow = typeof youtubePendingActions.$inferSelect
type Writer = Database | Transaction

export class YoutubeActionError extends Error {
	constructor(
		readonly code: 'BAD_REQUEST' | 'NOT_FOUND',
		message: string,
	) {
		super(message)
	}
}

export interface CreatePendingActionInput {
	workspaceId: string
	integrationId: string
	kind: string
	/** The exact request, as the executor will send it. */
	payload: Record<string, unknown>
	targetVideoId?: string | null
	/** The channel's public name. Resolved by the server code that calls this, not by the agent. */
	channelLabel?: string | null
	/** Free text from the agent. Shown on the card in its own labelled place, never in place of the payload. */
	agentNote?: string | null
	/** For a comment: the hash of its normalized text, kept after the payload is cleared. */
	textHash?: string | null
	/**
	 * Runs inside the transaction, before the row is stored. The write tools check their caps
	 * here, so two parallel calls cannot both pass a check that only one of them should.
	 */
	beforeInsert?: (tx: Transaction) => Promise<void>
	requestedByActor: string
	requestedBySession?: string | null
	/** The object the card sits on (the task or flow the change is for). */
	cardEntityId: string
	/** The people asked to decide. */
	approverIds: string[]
}

/** Stores a write the agent asked for and puts its card in front of the approvers. Never calls Google. */
export async function createPendingAction(db: Database, input: CreatePendingActionInput) {
	if (!(YOUTUBE_ACTION_KINDS as readonly string[]).includes(input.kind)) {
		throw new YoutubeActionError('BAD_REQUEST', `Unknown YouTube action kind: ${input.kind}`)
	}
	const kind = input.kind as YoutubeActionKind
	const canonical = canonicalJson(input.payload)
	if (canonical.length > YOUTUBE_PAYLOAD_MAX_CHARS) {
		throw new YoutubeActionError('BAD_REQUEST', 'The request is too large to hold for approval')
	}
	if ((input.channelLabel?.length ?? 0) > 200) {
		throw new YoutubeActionError('BAD_REQUEST', 'The channel name is too long')
	}
	if ((input.agentNote?.length ?? 0) > YOUTUBE_NOTE_MAX_CHARS) {
		throw new YoutubeActionError('BAD_REQUEST', 'The note is too long')
	}
	if (input.approverIds.length === 0) {
		throw new YoutubeActionError('BAD_REQUEST', 'A pending action needs a person to decide it')
	}

	return db.transaction(async (tx) => {
		const [integration] = await tx
			.select({ id: integrations.id, provider: integrations.provider })
			.from(integrations)
			.where(
				and(
					eq(integrations.id, input.integrationId),
					eq(integrations.workspaceId, input.workspaceId),
				),
			)
			.limit(1)
		if (!integration || integration.provider !== YOUTUBE_PROVIDER) {
			throw new YoutubeActionError(
				'NOT_FOUND',
				'No YouTube connection with that id in this workspace',
			)
		}

		await input.beforeInsert?.(tx)

		const [row] = await tx
			.insert(youtubePendingActions)
			.values({
				workspaceId: input.workspaceId,
				integrationId: input.integrationId,
				kind,
				payload: input.payload,
				payloadHash: hashYoutubePayload(input.payload),
				targetVideoId: input.targetVideoId ?? null,
				channelLabel: input.channelLabel ?? null,
				agentNote: input.agentNote?.trim() || null,
				textHash: input.textHash ?? null,
				requestedByActor: input.requestedByActor,
				requestedBySession: input.requestedBySession ?? null,
				expiresAt: new Date(Date.now() + YOUTUBE_ACTION_TTL_MS),
			})
			.returning()
		if (!row) throw new Error('Failed to store the pending action')

		const cardEventId = await postYoutubeActionCard(tx, {
			action: row,
			entityId: input.cardEntityId,
			authorId: input.requestedByActor,
			approverIds: input.approverIds,
		})
		await tx
			.update(youtubePendingActions)
			.set({ cardEventId })
			.where(eq(youtubePendingActions.id, row.id))
		return { id: row.id, status: row.status, expiresAt: row.expiresAt, cardEventId }
	})
}

type AuditDecision = 'approved' | 'rejected' | 'expired' | 'executed' | 'failed' | 'refused'

/** One audit row: ids, a category and a code. Never the payload, a title or an error string. */
export async function writeYoutubeAudit(
	writer: Writer,
	row: Pick<
		YoutubeActionRow,
		| 'id'
		| 'workspaceId'
		| 'integrationId'
		| 'kind'
		| 'payloadHash'
		| 'requestedBySession'
		| 'createdAt'
	>,
	entry: {
		decision: AuditDecision
		actorId?: string | null
		actorType?: string | null
		resultCode?: string | null
	},
) {
	await writer.insert(youtubeActionAudit).values({
		workspaceId: row.workspaceId,
		pendingActionId: row.id,
		integrationId: row.integrationId,
		kind: row.kind,
		decision: entry.decision,
		actorId: entry.actorId ?? null,
		actorType: entry.actorType ?? null,
		payloadHash: row.payloadHash,
		resultCode: entry.resultCode ?? null,
		requestedBySession: row.requestedBySession,
	})
	// The success event is sent from here, with the row, so it cannot drift from the audit.
	if (
		entry.decision === 'approved' ||
		entry.decision === 'rejected' ||
		entry.decision === 'expired'
	) {
		void trackYoutubeActionDecided({
			workspaceId: row.workspaceId,
			decidedBy: entry.actorId ?? null,
			kind: row.kind as TrackedActionKind,
			decision: entry.decision,
			requestedAt: row.createdAt,
			decidedAt: new Date(),
		})
	}
}

export type YoutubeDecisionResult =
	| { ok: true; decision: 'approve' | 'reject'; action: YoutubeActionRow }
	| {
			ok: false
			reason: 'not_found' | 'agent_actor' | 'not_pending' | 'expired' | 'payload_changed'
	  }

/**
 * A person's yes or no on one pending action. Only a human actor can decide: an agent is refused
 * and the refusal is recorded. The decision is one conditional update, so parallel taps cannot
 * both win. An approval is refused when the stored request no longer matches its hash, or when the
 * hash the caller saw is not the stored one.
 */
export async function decideYoutubeAction(
	writer: Writer,
	params: {
		workspaceId: string
		actionId: string
		actor: { id: string; type: string }
		decision: 'approve' | 'reject'
		/** The hash the person's card showed, when the caller has one. */
		expectedHash?: string
	},
): Promise<YoutubeDecisionResult> {
	const { workspaceId, actionId, actor, decision } = params
	const [row] = await writer
		.select()
		.from(youtubePendingActions)
		.where(
			and(
				eq(youtubePendingActions.id, actionId),
				eq(youtubePendingActions.workspaceId, workspaceId),
			),
		)
		.limit(1)
	if (!row) return { ok: false, reason: 'not_found' }

	if (actor.type !== 'human') {
		await writeYoutubeAudit(writer, row, {
			decision: 'refused',
			actorId: actor.id,
			actorType: actor.type,
			resultCode: 'agent_actor',
		})
		return { ok: false, reason: 'agent_actor' }
	}
	if (row.status !== 'pending') return { ok: false, reason: 'not_pending' }
	if (row.expiresAt.getTime() <= Date.now()) {
		await expireYoutubeActions(writer, { actionId })
		return { ok: false, reason: 'expired' }
	}

	if (decision === 'approve') {
		const stored = row.payload === null ? null : hashYoutubePayload(row.payload)
		if (stored !== row.payloadHash) {
			// The stored request is not the one that was hashed: nothing can approve it.
			await endYoutubeAction(writer, row, { status: 'failed', resultCode: 'payload_changed' })
			await writeYoutubeAudit(writer, row, {
				decision: 'refused',
				actorId: actor.id,
				actorType: actor.type,
				resultCode: 'payload_changed',
			})
			return { ok: false, reason: 'payload_changed' }
		}
		if (params.expectedHash !== undefined && params.expectedHash !== row.payloadHash) {
			await writeYoutubeAudit(writer, row, {
				decision: 'refused',
				actorId: actor.id,
				actorType: actor.type,
				resultCode: 'payload_changed',
			})
			return { ok: false, reason: 'payload_changed' }
		}
	}

	const [decided] = await writer
		.update(youtubePendingActions)
		.set({
			status: decision === 'approve' ? 'approved' : 'rejected',
			approvedBy: actor.id,
			approvedPayloadHash: decision === 'approve' ? row.payloadHash : null,
			decidedAt: new Date(),
			...(decision === 'reject' ? { payload: null, agentNote: null } : {}),
		})
		.where(
			and(
				eq(youtubePendingActions.id, row.id),
				eq(youtubePendingActions.status, 'pending'),
				sql`${youtubePendingActions.expiresAt} > now()`,
			),
		)
		.returning()
	if (!decided) return { ok: false, reason: 'not_pending' }

	await writeYoutubeAudit(writer, decided, {
		decision: decision === 'approve' ? 'approved' : 'rejected',
		actorId: actor.id,
		actorType: actor.type,
	})
	return { ok: true, decision, action: decided }
}

/** Ends an action: sets the final status and clears what it held. */
export async function endYoutubeAction(
	writer: Writer,
	row: Pick<YoutubeActionRow, 'id'>,
	end: { status: 'failed' | 'executed' | 'expired'; resultCode: string },
) {
	const now = new Date()
	await writer
		.update(youtubePendingActions)
		.set({
			status: end.status,
			resultCode: end.resultCode,
			payload: null,
			agentNote: null,
			...(end.status === 'executed' ? { executedAt: now } : {}),
		})
		.where(eq(youtubePendingActions.id, row.id))
}

/**
 * Expires what waited too long: a pending action nobody decided, or an approved one the executor
 * never claimed. Writes an audit row for each. Pass `actionId` to expire one.
 */
export async function expireYoutubeActions(writer: Writer, opts: { actionId?: string } = {}) {
	const expired = await writer
		.update(youtubePendingActions)
		.set({ status: 'expired', resultCode: 'expired', payload: null, agentNote: null })
		.where(
			and(
				inArray(youtubePendingActions.status, ['pending', 'approved']),
				isNull(youtubePendingActions.claimedAt),
				lte(youtubePendingActions.expiresAt, new Date()),
				...(opts.actionId ? [eq(youtubePendingActions.id, opts.actionId)] : []),
			),
		)
		.returning()
	for (const row of expired) {
		await writeYoutubeAudit(writer, row, { decision: 'expired', resultCode: 'expired' })
	}
	return expired.length
}

/**
 * The safety line "no public action without approval", read from the audit table: how many
 * actions were executed without an approved row for the same action. Should always be 0.
 */
export async function countUnapprovedYoutubeExecutions(
	db: Database,
	workspaceId?: string,
): Promise<number> {
	const result = await db.execute(sql`
		SELECT count(*)::int AS n
		FROM youtube_action_audit e
		WHERE e.decision = 'executed'
		${workspaceId ? sql`AND e.workspace_id = ${workspaceId}` : sql``}
		AND NOT EXISTS (
			SELECT 1 FROM youtube_action_audit a
			WHERE a.pending_action_id = e.pending_action_id AND a.decision = 'approved'
		)
	`)
	return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0)
}
