import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
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
	titles: Map<string, string>
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
