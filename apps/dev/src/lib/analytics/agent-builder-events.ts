import { capturePosthogEvent } from './posthog'

// Server-side PostHog emitters for the Single-prompt agent builder bet's
// Stage 1 ship metrics (agent_created volume and gap_report acceptance rate).
// Mirrors the shape of claude-failover-events.ts: one wrapper per event, a
// single capturePosthogEvent call, distinct_id = workspace_id.
//
// capturePosthogEvent is best-effort and never throws — see posthog.ts. Fire
// AFTER the underlying mutation (actor insert / comment insert) has committed
// so a row lock is not held across the network fetch to PostHog.
//
// Neither event fires on the underspecified early-return path (no actor is
// created) nor on actor-registration or comment-creation failure — callers are
// responsible for placing the call at the success-only code point.

interface AgentCreatedProps {
	workspaceId: string
	actorId: string
	generationTimeMs: number
}

export async function trackAgentCreated(p: AgentCreatedProps): Promise<void> {
	await capturePosthogEvent('agent_created', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		generation_time_ms: p.generationTimeMs,
	})
}

interface AgentGapReportPostedProps {
	workspaceId: string
	actorId: string
	generationTimeMs: number
}

export async function trackAgentGapReportPosted(p: AgentGapReportPostedProps): Promise<void> {
	await capturePosthogEvent('agent_gap_report_posted', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		generation_time_ms: p.generationTimeMs,
	})
}
