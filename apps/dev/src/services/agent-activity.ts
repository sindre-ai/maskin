import type { Database } from '@maskin/db'
import { events, actors, objects, sessions } from '@maskin/db/schema'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { WORKING_AGENT_DOING_MAX, clamp, groupWorkingAgents } from './live-activity-agents'
import { LIVE_STATUSES, openInteractiveTurnsByLog } from './live-activity-push'

/**
 * Event actions that count as the agent having changed an object. Object events are logged under
 * the object's own type (task, bet, insight ...), so the type is not filtered here: the outer
 * query only keeps ids that are objects of this workspace.
 */
const CHANGE_ACTIONS = ['updated', 'status_changed']

export type AgentObjectRow = {
	id: string
	type: string
	title: string | null
	status: string
	updatedAt: Date | null
}

/**
 * Objects an agent has created, changed or drives in a workspace, most recently updated first.
 * "Changed" comes from the events log (served by events_actor_object_idx); the other two read the
 * object row. Fetches one extra row so the caller can say whether there is a next page.
 */
export async function listAgentObjects(
	db: Database,
	input: { workspaceId: string; actorId: string; limit: number; offset: number },
): Promise<{ items: AgentObjectRow[]; hasMore: boolean }> {
	const { workspaceId, actorId, limit, offset } = input
	const changedByAgent = db
		.select({ id: events.entityId })
		.from(events)
		.where(and(eq(events.actorId, actorId), inArray(events.action, CHANGE_ACTIONS)))
	const rows = await db
		.select({
			id: objects.id,
			type: objects.type,
			title: objects.title,
			status: objects.status,
			updatedAt: objects.updatedAt,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				or(
					eq(objects.createdBy, actorId),
					eq(objects.driver, actorId),
					inArray(objects.id, changedByAgent),
				),
			),
		)
		.orderBy(desc(objects.updatedAt), desc(objects.id))
		.limit(limit + 1)
		.offset(offset)
	return { items: rows.slice(0, limit), hasMore: rows.length > limit }
}

export type AgentWorkingNow = {
	sessionId: string
	doing: string
	startedAt: Date
	conversationId: string | null
}

/**
 * What an agent is doing right now, from its live session, or null when it is not working.
 *
 * Read per turn, not per session (docs/pitfalls/per-session-vs-per-turn-signal.md): a chat session
 * stays running between turns, so an interactive session only counts while its newest log row is
 * recent and is not the closing result row. Same rule and same line as the Live Activity push: the
 * activity text is cut to the push's length and falls back to "working". No chat title, tool
 * arguments or log text goes into it.
 */
export async function loadAgentWorkingNow(
	db: Database,
	input: { workspaceId: string; actorId: string; nowMs: number },
): Promise<AgentWorkingNow | null> {
	const rows = await db
		.select({
			sessionId: sessions.id,
			actorId: sessions.actorId,
			agentName: actors.name,
			currentActivity: sessions.currentActivity,
			interactive: sessions.interactive,
			startedAt: sessions.startedAt,
			createdAt: sessions.createdAt,
			conversationId: sessions.conversationId,
		})
		.from(sessions)
		.innerJoin(actors, eq(actors.id, sessions.actorId))
		.where(
			and(
				eq(sessions.workspaceId, input.workspaceId),
				eq(sessions.actorId, input.actorId),
				inArray(sessions.status, LIVE_STATUSES),
			),
		)
	if (rows.length === 0) return null

	const openTurns = await openInteractiveTurnsByLog(
		db,
		rows.filter((r) => r.interactive).map((r) => r.sessionId),
		input.nowMs,
	)
	const working = groupWorkingAgents(
		rows
			.filter((r) => !r.interactive || openTurns.has(r.sessionId))
			.map((r) => ({
				sessionId: r.sessionId,
				actorId: r.actorId,
				agentName: r.agentName,
				currentActivity: r.currentActivity,
				startedAt: r.startedAt ?? r.createdAt ?? new Date(input.nowMs),
				conversationId: r.conversationId,
				topic: null,
			})),
	)[0]
	if (!working) return null
	return {
		sessionId: working.sessionId,
		doing: clamp(working.doing, WORKING_AGENT_DOING_MAX, 'working'),
		startedAt: working.startedAt,
		conversationId: working.conversationId ?? null,
	}
}
