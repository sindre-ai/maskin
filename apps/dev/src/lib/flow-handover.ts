import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * A flow (a loop object) can opt in to "a handover is a task, a mention starts nothing" with
 * metadata.handover_is_task = true (bet "Flows that run like development", rule 6). An agent's
 * @mention of another agent on an object in that flow then writes the notification and starts no
 * run: the agent that needs work creates a task, and a ready task starts its owner.
 *
 * Off everywhere: a flow without the key keeps today's behaviour, where a mention starts a run.
 */
export const HANDOVER_IS_TASK_KEY = 'handover_is_task'

/**
 * The development team's mentions always start a run, whatever flow they sit in. By name, as the
 * Developer is found by name in task-session-restart.ts.
 */
export const DEVELOPMENT_TEAM_NAMES: readonly string[] = [
	'Developer',
	'Senior Developer',
	'Code Reviewer',
	'Strategist',
	'CTO',
	'Infra & DevOps',
	'Bet Planner',
	'Development Driver',
	'Workspace Driver',
]

export function isDevelopmentTeamAgent(name: string | null | undefined): boolean {
	return !!name && DEVELOPMENT_TEAM_NAMES.includes(name)
}

/** Whether a flow's metadata has opted in. Only the boolean true counts. */
export function flowOptsIntoHandoverTask(metadata: unknown): boolean {
	return (
		!!metadata &&
		typeof metadata === 'object' &&
		(metadata as Record<string, unknown>)[HANDOVER_IS_TASK_KEY] === true
	)
}

/**
 * Whether an agent's mention of `mentionedAgentName` on `objectId` starts no run. True when the
 * object, or the object it breaks out of (a task under an event, a bet or a contact), sits in a
 * flow that opted in, and the mentioned agent is not on the development team.
 */
export async function mentionStartsNoRun(
	db: Database,
	ctx: { workspaceId: string; objectId: string; mentionedAgentName: string | null },
): Promise<boolean> {
	if (isDevelopmentTeamAgent(ctx.mentionedAgentName)) return false

	const parents = await db
		.select({ id: relationships.sourceId })
		.from(relationships)
		.where(
			and(
				eq(relationships.targetId, ctx.objectId),
				eq(relationships.type, 'breaks_into'),
				eq(relationships.sourceType, 'object'),
				eq(relationships.targetType, 'object'),
			),
		)
	const memberIds = [ctx.objectId, ...parents.map((p) => p.id)]

	const [optedIn] = await db
		.select({ id: objects.id })
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.sourceId))
		.where(
			and(
				eq(relationships.type, 'in_loop'),
				eq(relationships.sourceType, 'object'),
				inArray(relationships.targetId, memberIds),
				eq(objects.type, 'loop'),
				eq(objects.workspaceId, ctx.workspaceId),
				sql`${objects.metadata}->>${HANDOVER_IS_TASK_KEY}::text = 'true'`,
			),
		)
		.limit(1)
	return !!optedIn
}
