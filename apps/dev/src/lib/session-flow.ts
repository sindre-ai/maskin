import type { Database } from '@maskin/db'
import { objects, relationships, sessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/** Ids per `in_loop` edge lookup, well under Postgres' bind-parameter limit. */
const EDGE_LOOKUP_CHUNK = 5_000

/** The two columns of a session that say which flow it belongs to. */
export type SessionFlowKeys = {
	triggerId: string | null
	initiatedFromObjectId: string | null
}

export type FlowLookup = {
	/** Flow id to flow title, for every flow in the workspace. */
	titles: Map<string, string | null>
	/** The flow a session belongs to, or null when it ties to none. */
	flowIdOf: (session: SessionFlowKeys) => string | null
}

/**
 * Sessions carry no flow column. A session belongs to the flow that lists its trigger, else the
 * flow its source item sits in (the `in_loop` edge). When several flows qualify the lowest id
 * wins, so a session is never counted twice. A session with neither ties to no flow.
 *
 * One lookup per workspace: the flow list is read once, then the edges for the items of the
 * sessions that no trigger placed.
 */
export async function loadFlowLookup(
	db: Database,
	workspaceId: string,
	sessionKeys: SessionFlowKeys[],
): Promise<FlowLookup> {
	const loopRows = await db
		.select({
			id: objects.id,
			title: objects.title,
			triggerIds: sql<string[] | null>`${objects.metadata}->'trigger_ids'`,
		})
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))
		.orderBy(objects.id)
	const titles = new Map(loopRows.map((l) => [l.id, l.title]))
	const loopByTrigger = new Map<string, string>()
	for (const loop of loopRows) {
		if (!Array.isArray(loop.triggerIds)) continue
		for (const triggerId of loop.triggerIds) {
			if (typeof triggerId === 'string' && !loopByTrigger.has(triggerId)) {
				loopByTrigger.set(triggerId, loop.id)
			}
		}
	}

	const loopByItem = new Map<string, string>()
	const itemIds = [
		...new Set(
			sessionKeys
				.filter((s) => !(s.triggerId && loopByTrigger.has(s.triggerId)))
				.map((s) => s.initiatedFromObjectId)
				.filter((id): id is string => id !== null),
		),
	]
	if (titles.size > 0) {
		for (let i = 0; i < itemIds.length; i += EDGE_LOOKUP_CHUNK) {
			const edges = await db
				.select({ loopId: relationships.sourceId, itemId: relationships.targetId })
				.from(relationships)
				.where(
					and(
						eq(relationships.type, 'in_loop'),
						inArray(relationships.targetId, itemIds.slice(i, i + EDGE_LOOKUP_CHUNK)),
						inArray(relationships.sourceId, [...titles.keys()]),
					),
				)
				.orderBy(relationships.sourceId)
			for (const edge of edges) {
				if (!loopByItem.has(edge.itemId)) loopByItem.set(edge.itemId, edge.loopId)
			}
		}
	}

	return {
		titles,
		flowIdOf: (s) =>
			(s.triggerId ? loopByTrigger.get(s.triggerId) : undefined) ??
			(s.initiatedFromObjectId ? loopByItem.get(s.initiatedFromObjectId) : undefined) ??
			null,
	}
}

/** The stored statuses of a flow in pilot: agents run, but nothing leaves the company unasked. */
export const PILOT_FLOW_STATUSES: readonly string[] = ['pilot']

/**
 * The session a send call comes from. A session key names its session and cannot be left off or
 * forged, so it comes first; the header is only the fallback for a call whose key is not a
 * session key (a person chatting sends none).
 */
export function callingSessionId(
	apiKeySessionId: string | null | undefined,
	headerSessionId: string | undefined,
): string | undefined {
	return apiKeySessionId ?? headerSessionId
}

/** How far up the helper chain a session inherits its flow from. */
const MAX_SPAWN_HOPS = 5

export type SessionFlow = { id: string; status: string }

/**
 * The flows one running session belongs to, read now. The same rules as `loadFlowLookup`
 * (the flow that lists the session's trigger, else the flow its source item sits in), with two
 * differences on purpose: a helper session inherits the flows of the session that started it
 * (up to 5 hops), and when several flows qualify all of them are returned, so a caller can hold
 * on the strictest.
 *
 * The session id is a claim from a header, so it counts only when the session is in this
 * workspace and belongs to this agent. Anything else ties to no flow, like a call with no id.
 * A database error is thrown: the caller decides what an unreadable answer means.
 */
export async function flowsOfSession(
	db: Database,
	params: { workspaceId: string; agentId: string; sessionId: string },
): Promise<SessionFlow[]> {
	const { workspaceId, agentId, sessionId } = params
	const found = new Map<string, SessionFlow>()
	let currentId: string | null = sessionId
	for (let hop = 0; currentId && hop <= MAX_SPAWN_HOPS; hop++) {
		const [session] = await db
			.select({
				actorId: sessions.actorId,
				triggerId: sessions.triggerId,
				initiatedFromObjectId: sessions.initiatedFromObjectId,
				spawnedBySessionId: sessions.spawnedBySessionId,
			})
			.from(sessions)
			.where(and(eq(sessions.id, currentId), eq(sessions.workspaceId, workspaceId)))
			.limit(1)
		if (!session) break
		// Only the session the caller named has to be the caller's own; a helper's parent is
		// whoever started it.
		if (hop === 0 && session.actorId !== agentId) break

		const byTrigger = session.triggerId
			? await db
					.select({ id: objects.id, status: objects.status })
					.from(objects)
					.where(
						and(
							eq(objects.workspaceId, workspaceId),
							eq(objects.type, 'loop'),
							sql`${objects.metadata}->'trigger_ids' @> ${JSON.stringify([session.triggerId])}::jsonb`,
						),
					)
			: []
		const flows =
			byTrigger.length > 0 || !session.initiatedFromObjectId
				? byTrigger
				: await db
						.select({ id: objects.id, status: objects.status })
						.from(relationships)
						.innerJoin(objects, eq(objects.id, relationships.sourceId))
						.where(
							and(
								eq(relationships.type, 'in_loop'),
								eq(relationships.targetId, session.initiatedFromObjectId),
								eq(objects.workspaceId, workspaceId),
								eq(objects.type, 'loop'),
							),
						)
		// A session woken on the flow itself (the answer to one of its cards) belongs to that flow.
		const own =
			flows.length === 0 && session.initiatedFromObjectId
				? await db
						.select({ id: objects.id, status: objects.status })
						.from(objects)
						.where(
							and(
								eq(objects.id, session.initiatedFromObjectId),
								eq(objects.workspaceId, workspaceId),
								eq(objects.type, 'loop'),
							),
						)
				: []
		for (const flow of [...flows, ...own]) found.set(flow.id, flow)
		currentId = session.spawnedBySessionId
	}
	return [...found.values()]
}
