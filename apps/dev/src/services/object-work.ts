import type { Database } from '@maskin/db'
import { objects, sessions } from '@maskin/db/schema'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'

/**
 * "An agent is working on this object" bookkeeping.
 *
 * `objects.active_session_id` is the live pointer the list badge, the Working
 * filter, the detail banner and `get_objects` read. Every set and clear also
 * writes a permanent `agent_started_working` / `agent_finished_working` event
 * so the object's Activity history keeps a record once the session is gone.
 *
 * The events use entity type `object`, not the object's own type: a trigger
 * with `entity_type: 'task'` and no `action` filter matches every event on a
 * task, so an event of that type could start a session that emits another one.
 * Neither helper ever throws; this is annotation on top of the session, and a
 * failure here must not fail the session start or teardown that called it.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AGENT_STARTED_WORKING = 'agent_started_working'
export const AGENT_FINISHED_WORKING = 'agent_finished_working'

/**
 * Point an object at the session working on it and log it. Last writer wins: a
 * second session started on the same object takes over the pointer. Returns
 * false when the object is not in the workspace or already points at this
 * session (so a repeat call records nothing).
 */
export async function startWorkingOnObject(
	db: Database,
	params: { workspaceId: string; objectId: string; sessionId: string; actorId: string },
): Promise<boolean> {
	// A session id that is not a uuid cannot be a sessions row; skip the query
	// instead of letting Postgres reject it.
	if (!UUID_RE.test(params.sessionId)) return false
	try {
		const [row] = await db
			.update(objects)
			.set({ activeSessionId: params.sessionId })
			.where(
				and(
					eq(objects.id, params.objectId),
					eq(objects.workspaceId, params.workspaceId),
					or(isNull(objects.activeSessionId), ne(objects.activeSessionId, params.sessionId)),
				),
			)
			.returning({ id: objects.id })
		if (!row) return false
		await recordEvent(db, {
			workspaceId: params.workspaceId,
			actorId: params.actorId,
			action: AGENT_STARTED_WORKING,
			entityType: 'object',
			entityId: params.objectId,
			data: { session_id: params.sessionId },
		})
		return true
	} catch (err) {
		logger.warn('Could not link object to active session', {
			sessionId: params.sessionId,
			objectId: params.objectId,
			error: String(err),
		})
		return false
	}
}

/**
 * Clear the pointer on every object that still points at this session and log
 * it. Called when the session ends and when an agent says it is done; a second
 * call finds nothing to clear and records nothing.
 */
export async function stopWorkingOnObjects(
	db: Database,
	params: { sessionId: string; objectId?: string },
): Promise<void> {
	try {
		const cleared = await db
			.update(objects)
			.set({ activeSessionId: null })
			.where(
				and(
					eq(objects.activeSessionId, params.sessionId),
					params.objectId ? eq(objects.id, params.objectId) : undefined,
				),
			)
			.returning({ id: objects.id, workspaceId: objects.workspaceId })
		if (cleared.length === 0) return

		const [session] = await db
			.select({ actorId: sessions.actorId, startedAt: sessions.startedAt })
			.from(sessions)
			.where(eq(sessions.id, params.sessionId))
			.limit(1)
		if (!session) return
		const durationSeconds = session.startedAt
			? Math.max(0, Math.round((Date.now() - session.startedAt.getTime()) / 1000))
			: null
		for (const object of cleared) {
			await recordEvent(db, {
				workspaceId: object.workspaceId,
				actorId: session.actorId,
				action: AGENT_FINISHED_WORKING,
				entityType: 'object',
				entityId: object.id,
				data: { session_id: params.sessionId, duration_seconds: durationSeconds },
			})
		}
	} catch (err) {
		logger.warn('Failed to clear activeSessionId', {
			sessionId: params.sessionId,
			error: String(err),
		})
	}
}
