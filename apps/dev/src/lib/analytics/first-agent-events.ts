import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, count, eq, ne } from 'drizzle-orm'
import { capturePosthogEvent } from './posthog'

// One event per workspace, when its first agent exists. `source` says who made
// it: 'onboarding' is the default agents seeded when the workspace is created,
// 'person' is an agent someone made through the create-agent route into a
// workspace that had none. Only ids go out, never names.
export const FIRST_AGENT_CREATED = 'first_agent_created'

export type FirstAgentSource = 'onboarding' | 'person'

export async function trackFirstAgentCreated(p: {
	workspaceId: string
	distinctId: string
	agentId?: string
	source: FirstAgentSource
}): Promise<void> {
	await capturePosthogEvent(FIRST_AGENT_CREATED, p.distinctId, {
		workspace_id: p.workspaceId,
		actor_id: p.distinctId,
		agent_id: p.agentId,
		source: p.source,
	})
}

// True when the workspace has no agent member other than the one just added.
export async function isFirstAgentInWorkspace(
	db: Database,
	workspaceId: string,
	newAgentId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ n: count() })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.type, 'agent'),
				ne(actors.id, newAgentId),
			),
		)
	return (row?.n ?? 0) === 0
}
