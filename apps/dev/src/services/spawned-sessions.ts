import type { Database } from '@maskin/db'
import { actors, conversationParticipants, sessions } from '@maskin/db/schema'
import { and, eq, inArray, isNull } from 'drizzle-orm'

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
	startedAt: string | null
	completedAt: string | null
	durationMs: number | null
	result: unknown
	currentActivity: string | null
	depends_on_session_ids: string[]
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
			startedAt: sessions.startedAt,
			completedAt: sessions.completedAt,
			durationMs: sessions.durationMs,
			result: sessions.result,
			currentActivity: sessions.currentActivity,
			depends_on_session_ids: sessions.dependsOnSessionIds,
			spawnedByMessageId: sessions.spawnedByMessageId,
		})
		.from(sessions)
		.innerJoin(actors, eq(actors.id, sessions.actorId))
		.where(
			and(
				inArray(sessions.spawnedByMessageId, opts.messageIds),
				// Entitlement: the sub-session must belong to the conversation
				// being listed, in the workspace the header scoped us to.
				eq(sessions.conversationId, opts.conversationId),
				eq(sessions.workspaceId, opts.workspaceId),
			),
		)
		.orderBy(sessions.startedAt)

	for (const row of rows) {
		const key = row.spawnedByMessageId
		if (key === null) continue
		const bucket = byMessage.get(key)
		if (!bucket) continue
		bucket.push({
			id: row.id,
			status: row.status,
			actorId: row.actorId,
			actorName: row.actorName,
			actionPrompt: row.actionPrompt,
			startedAt: row.startedAt ? row.startedAt.toISOString() : null,
			completedAt: row.completedAt ? row.completedAt.toISOString() : null,
			durationMs: row.durationMs,
			result: row.result ?? null,
			currentActivity: row.currentActivity,
			depends_on_session_ids: row.depends_on_session_ids ?? [],
		})
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
			conversationId: sessions.conversationId,
		})
		.from(sessions)
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
