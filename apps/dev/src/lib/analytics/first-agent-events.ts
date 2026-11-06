import { capturePosthogEvent } from './posthog'

// One event per workspace, when onboarding seeds its default agents. Agents a
// person adds later through the create-agent route are already counted by
// `agent_created`, so `source` is only ever 'onboarding' today. Only ids go
// out, never names.
export const FIRST_AGENT_CREATED = 'first_agent_created'

export type FirstAgentSource = 'onboarding'

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
