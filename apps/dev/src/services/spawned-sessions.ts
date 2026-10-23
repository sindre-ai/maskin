import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	messages,
	sessions,
} from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Sub-session delegation strip (bet/444b-handed-off-strip).
 *
 * A sub-session is a `sessions` row with `spawned_by_message_id` set — it was
 * spawned from an assistant message inside a conversation. Two consumers read
 * the same shape: the `spawned_sessions` embed on `list_conversation_messages`
 * and the `session.state_changed` SSE frame on `GET /api/events`.
 *
 * Entitlement is participant-scoped, not workspace-scoped. Two members of the
 * same workspace can be in different conversations, and `action_prompt` is
 * surfaced on this shape — a workspace-only gate would leak one conversation's
 * sub-agent prompt to a member who is not in it. Every read therefore resolves
 * the caller's participation in the owning conversation first.
 */

export interface SpawnedSessionEmbed {
	id: string
	status: string
	actorId: string
	actorName: string
	actionPrompt: string
	/** When the session was created: where its card sits in the chat's timeline. */
	createdAt: string | null
	startedAt: string | null
	completedAt: string | null
	durationMs: number | null
	result: unknown
	currentActivity: string | null
	depends_on_session_ids: string[]
	/** What the session is waiting on the person for; null when it is not waiting. */
	awaiting: { message_id: number; question: unknown } | null
	/** The session this one carries on, when the person wrote to a helper that had ended. */
	continues_session_id: string | null
}

export interface SessionStateChangedPayload {
	session_id: string
	status: string
	duration_ms: number | null
	depends_on_session_ids: string[]
	result: unknown
	current_activity: string | null
}

/** Active participant of a conversation. `left_at IS NULL` mirrors the listing indexes. */
export async function isConversationParticipant(
	db: Database,
	conversationId: string,
	actorId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ conversationId: conversationParticipants.conversationId })
		.from(conversationParticipants)
		.where(
			and(
				eq(conversationParticipants.conversationId, conversationId),
				eq(conversationParticipants.actorId, actorId),
				isNull(conversationParticipants.leftAt),
			),
		)
		.limit(1)
	return Boolean(row)
}

/** `config.awaiting`, written when the session asks a question and cleared on the answer. */
function readAwaiting(config: unknown): SpawnedSessionEmbed['awaiting'] {
	const awaiting = (config as { awaiting?: unknown } | null)?.awaiting
	if (!awaiting || typeof awaiting !== 'object') return null
	const { message_id, question } = awaiting as { message_id?: unknown; question?: unknown }
	return typeof message_id === 'number' ? { message_id, question } : null
}

function toEmbed(row: {
	id: string
	status: string
	actorId: string
	actorName: string
	actionPrompt: string
	createdAt: Date | null
	startedAt: Date | null
	completedAt: Date | null
	durationMs: number | null
	result: unknown
	currentActivity: string | null
	depends_on_session_ids: string[] | null
	config: unknown
}): SpawnedSessionEmbed {
	return {
		id: row.id,
		status: row.status,
		actorId: row.actorId,
		actorName: row.actorName,
		actionPrompt: row.actionPrompt,
		createdAt: row.createdAt ? row.createdAt.toISOString() : null,
		startedAt: row.startedAt ? row.startedAt.toISOString() : null,
		completedAt: row.completedAt ? row.completedAt.toISOString() : null,
		durationMs: row.durationMs,
		result: row.result ?? null,
		currentActivity: row.currentActivity,
		depends_on_session_ids: row.depends_on_session_ids ?? [],
		awaiting: readAwaiting(row.config),
		continues_session_id:
			typeof (row.config as { continues_session_id?: unknown } | null)?.continues_session_id ===
			'string'
				? (row.config as { continues_session_id: string }).continues_session_id
				: null,
	}
}

/**
 * Batched sub-session embed for a page of messages. Returns one entry per
 * message id (empty array included) so callers can spread it unconditionally.
 * Returns nothing at all when the caller is not a participant of the
 * conversation — the embed is a participant-scoped surface.
 */
export async function loadSpawnedSessionsByMessage(
	db: Database,
	opts: { conversationId: string; workspaceId: string; messageIds: number[]; actorId: string },
): Promise<Map<number, SpawnedSessionEmbed[]>> {
	const byMessage = new Map<number, SpawnedSessionEmbed[]>()
	for (const id of opts.messageIds) byMessage.set(id, [])

	if (opts.messageIds.length === 0) return byMessage

	const entitled = await isConversationParticipant(db, opts.conversationId, opts.actorId)
	if (!entitled) return byMessage

	const rows = await db
		.select({
			id: sessions.id,
			status: sessions.status,
			actorId: sessions.actorId,
			actorName: actors.name,
			actionPrompt: sessions.actionPrompt,
			createdAt: sessions.createdAt,
			startedAt: sessions.startedAt,
			completedAt: sessions.completedAt,
			durationMs: sessions.durationMs,
			result: sessions.result,
			currentActivity: sessions.currentActivity,
			depends_on_session_ids: sessions.dependsOnSessionIds,
			config: sessions.config,
			spawnedByMessageId: sessions.spawnedByMessageId,
		})
		.from(sessions)
		.innerJoin(actors, eq(actors.id, sessions.actorId))
		// The anchor message is what ties a sub-session to this conversation: a
		// session started over REST by an agent never carries
		// `sessions.conversation_id`, only the message it was handed off from.
		.innerJoin(messages, eq(messages.id, sessions.spawnedByMessageId))
		.where(
			and(
				inArray(sessions.spawnedByMessageId, opts.messageIds),
				// Entitlement: the anchor message must live in the conversation
				// being listed, in the workspace the header scoped us to.
				eq(messages.conversationId, opts.conversationId),
				eq(sessions.workspaceId, opts.workspaceId),
			),
		)
		.orderBy(sessions.startedAt)

	for (const row of rows) {
		const key = row.spawnedByMessageId
		if (key === null) continue
		const bucket = byMessage.get(key)
		if (!bucket) continue
		bucket.push(toEmbed(row))
	}

	return byMessage
}

/**
 * Build the `session.state_changed` frame for a session event, or null when the
 * caller must not receive it. Null covers all three refusal reasons at once:
 * unknown session, workspace mismatch, not a sub-session, or a caller who is
 * not a participant of the owning conversation. Nothing that fails here is ever
 * written to the wire, so the gate sits literally on the emission path.
 */
export async function loadSessionStateChangeFrame(
	db: Database,
	opts: { sessionId: string; workspaceId: string; actorId: string },
): Promise<SessionStateChangedPayload | null> {
	const [row] = await db
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			status: sessions.status,
			durationMs: sessions.durationMs,
			result: sessions.result,
			currentActivity: sessions.currentActivity,
			dependsOnSessionIds: sessions.dependsOnSessionIds,
			spawnedByMessageId: sessions.spawnedByMessageId,
			conversationId: messages.conversationId,
		})
		.from(sessions)
		// Same anchor-message join as the embed: the conversation comes from the
		// message the session was handed off from, not `sessions.conversation_id`.
		.leftJoin(messages, eq(messages.id, sessions.spawnedByMessageId))
		.where(eq(sessions.id, opts.sessionId))
		.limit(1)

	if (!row) return null
	if (row.workspaceId !== opts.workspaceId) return null
	// Only sub-sessions are in scope — a tool-call or standalone session has no
	// delegation strip and must not broadcast its prompt or state.
	if (row.spawnedByMessageId === null || row.conversationId === null) return null

	const entitled = await isConversationParticipant(db, row.conversationId, opts.actorId)
	if (!entitled) return null

	return {
		session_id: row.id,
		status: row.status,
		duration_ms: row.durationMs,
		depends_on_session_ids: row.dependsOnSessionIds ?? [],
		result: row.result ?? null,
		current_activity: row.currentActivity,
	}
}

/**
 * Whether `actorId` may anchor a sub-session to `messageId`. The anchor is what
 * puts the session's prompt and state in front of that conversation's
 * participants, so a caller-supplied id is only honoured for a message in this
 * workspace whose conversation the caller is an active participant of.
 */
export async function canAnchorToMessage(
	db: Database,
	opts: { messageId: number; workspaceId: string; actorId: string },
): Promise<boolean> {
	const [row] = await db
		.select({ conversationId: messages.conversationId })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(and(eq(messages.id, opts.messageId), eq(conversations.workspaceId, opts.workspaceId)))
		.limit(1)
	if (!row) return false
	return isConversationParticipant(db, row.conversationId, opts.actorId)
}

/**
 * Anchor the sub-sessions an agent started since its previous message in a chat
 * to the message it has just posted. The agent narrates a handoff in the turn
 * itself ("Running a second dry run…"), long before the turn's final output
 * lands, so waiting for the finalizer would leave the card missing for the whole
 * run. The finalizer's own backfill only touches sessions still unanchored, so
 * the two never fight.
 *
 * Best-effort: a failure here must not fail the message post.
 */
export async function anchorSpawnedSessionsToMessage(
	db: Database,
	opts: {
		spawnerSessionId: string
		conversationId: string
		actorId: string
		messageId: number
	},
): Promise<void> {
	try {
		const [previous] = await db
			.select({ createdAt: messages.createdAt })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, opts.conversationId),
					eq(messages.actorId, opts.actorId),
					lt(messages.id, opts.messageId),
				),
			)
			.orderBy(desc(messages.id))
			.limit(1)
		let lowerBound = previous?.createdAt ?? null
		if (!lowerBound) {
			const [spawner] = await db
				.select({ createdAt: sessions.createdAt })
				.from(sessions)
				.where(eq(sessions.id, opts.spawnerSessionId))
				.limit(1)
			lowerBound = spawner?.createdAt ?? null
		}
		if (!lowerBound) return
		await db
			.update(sessions)
			.set({ spawnedByMessageId: opts.messageId })
			.where(
				and(
					eq(sessions.spawnedBySessionId, opts.spawnerSessionId),
					isNull(sessions.spawnedByMessageId),
					gt(sessions.createdAt, lowerBound),
				),
			)
	} catch (err) {
		logger.warn('Could not anchor spawned sessions to posted message', {
			spawner_session_id: opts.spawnerSessionId,
			message_id: opts.messageId,
			error: String(err),
		})
	}
}

/**
 * Sub-sessions the chat's own agents have started that no message carries yet.
 * An agent calls `create_session` mid-turn and only narrates it afterwards, so
 * for that stretch the handoff exists with nowhere to hang. Returned beside the
 * message list so the chat can show it straight away; once a message anchors
 * the session it moves into that message's embed and leaves this list.
 */
export async function loadPendingSpawnedSessions(
	db: Database,
	opts: { conversationId: string; workspaceId: string; actorId: string },
): Promise<SpawnedSessionEmbed[]> {
	const entitled = await isConversationParticipant(db, opts.conversationId, opts.actorId)
	if (!entitled) return []

	const chatSessionIds = db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.conversationId, opts.conversationId),
				eq(sessions.workspaceId, opts.workspaceId),
			),
		)

	const rows = await db
		.select({
			id: sessions.id,
			status: sessions.status,
			actorId: sessions.actorId,
			actorName: actors.name,
			actionPrompt: sessions.actionPrompt,
			createdAt: sessions.createdAt,
			startedAt: sessions.startedAt,
			completedAt: sessions.completedAt,
			durationMs: sessions.durationMs,
			result: sessions.result,
			currentActivity: sessions.currentActivity,
			depends_on_session_ids: sessions.dependsOnSessionIds,
			config: sessions.config,
		})
		.from(sessions)
		.innerJoin(actors, eq(actors.id, sessions.actorId))
		.where(
			and(
				isNull(sessions.spawnedByMessageId),
				eq(sessions.workspaceId, opts.workspaceId),
				inArray(sessions.spawnedBySessionId, chatSessionIds),
			),
		)
		.orderBy(sessions.createdAt)
	return rows.map(toEmbed)
}

/**
 * The chat a helper session may ask its questions in: the conversation of the
 * session that started it (or, for a helper of a helper, the one it inherited).
 * Null when the spawner is not in a chat — there is then nobody to ask.
 *
 * It is stored on the helper's config, not on `sessions.conversation_id`: that
 * column makes a session a chat session (workspace-capacity exemption, the
 * one-active-session-per-agent-per-chat index, the responder's session lookup),
 * and a helper must be none of those.
 */
export async function resolveAskConversationId(
	db: Database,
	spawnerSessionId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ conversationId: sessions.conversationId, config: sessions.config })
		.from(sessions)
		.where(eq(sessions.id, spawnerSessionId))
		.limit(1)
	if (!row) return null
	if (row.conversationId) return row.conversationId
	const inherited = (row.config as { ask_conversation_id?: unknown } | null)?.ask_conversation_id
	return typeof inherited === 'string' ? inherited : null
}
