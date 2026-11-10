import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'

export type FlowRef = { id: string; title: string }

/**
 * The flow a single run belongs to, by the same rule the billing usage breakdown uses for all runs
 * at once (lib/billing-usage-breakdown.ts): the flow that lists the run's trigger, else the flow
 * its source item sits in (the `in_loop` edge). When several qualify the lowest id wins. Runs are
 * not stored with a flow, so a run with neither gets null.
 */
export async function findFlowForRun(
	db: Database,
	run: {
		workspaceId: string
		triggerId: string | null
		initiatedFromObjectId: string | null
	},
): Promise<FlowRef | null> {
	if (run.triggerId) {
		const [byTrigger] = await db
			.select({ id: objects.id, title: objects.title })
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, run.workspaceId),
					eq(objects.type, 'loop'),
					sql`${objects.metadata}->'trigger_ids' @> ${JSON.stringify([run.triggerId])}::jsonb`,
				),
			)
			.orderBy(asc(objects.id))
			.limit(1)
		if (byTrigger) return byTrigger
	}
	if (run.initiatedFromObjectId) {
		const [byItem] = await db
			.select({ id: objects.id, title: objects.title })
			.from(relationships)
			.innerJoin(objects, eq(objects.id, relationships.sourceId))
			.where(
				and(
					eq(relationships.type, 'in_loop'),
					eq(relationships.targetId, run.initiatedFromObjectId),
					eq(objects.workspaceId, run.workspaceId),
					eq(objects.type, 'loop'),
				),
			)
			.orderBy(asc(relationships.sourceId))
			.limit(1)
		if (byItem) return byItem
	}
	return null
}
