import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { canReadSession } from '../lib/session-access'
import { sessionFailureReason } from '../lib/session-failure-reason'

export interface ObjectLastSession {
	id: string
	status: string
	agent_id: string
	started_at: string | null
	/** Short message, set only when the session failed. Never raw log text. */
	failure_reason: string | null
	/** The chat the session answered in or was started from, if any. */
	chat_id: string | null
	created_by_actor_id: string
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The newest session started for an object, for the failure, origin and
 * Watch/Stop cards. A live session (`activeSessionId`) wins; otherwise the
 * latest row linked through `sessions.initiated_from_object_id`. Null when the
 * object has no session, or the caller may not read it (a session a person
 * started stays private to them, same rule as GET /sessions/:id).
 */
export async function loadObjectLastSession(
	db: Database,
	object: { id: string; workspaceId: string; activeSessionId: string | null },
	caller: { actorId: string; workspaceRole?: string },
): Promise<ObjectLastSession | null> {
	const scope = eq(sessions.workspaceId, object.workspaceId)
	const [row] = await db
		.select()
		.from(sessions)
		.where(
			and(
				scope,
				object.activeSessionId
					? eq(sessions.id, object.activeSessionId)
					: eq(sessions.initiatedFromObjectId, object.id),
			),
		)
		.orderBy(desc(sessions.createdAt))
		.limit(1)
	if (!row) return null
	if (!(await canReadSession(db, row, caller.actorId, caller.workspaceRole))) return null

	const config = (row.config ?? {}) as Record<string, unknown>
	return {
		id: row.id,
		status: row.status,
		agent_id: row.actorId,
		started_at: row.startedAt?.toISOString() ?? null,
		failure_reason: sessionFailureReason(row.status, row.result),
		chat_id:
			row.conversationId ??
			stringOrNull(config.origin_conversation_id) ??
			stringOrNull(config.ask_conversation_id),
		created_by_actor_id: row.createdBy,
	}
}
