import { capturePosthogEvent } from './posthog'

// Server-side emitter for the design-agent prototype review bet's ship metric
// ("≥1 reviewer-flagged interaction issue caught at design time"). A reviewer
// signals an interaction-layer issue by posting a comment with
// `metadata.issue_category` set to one of the five enums below — usually via
// the MCP `create_comment` tool today, a future UI later. The handler in
// `apps/dev/src/routes/events.ts` calls `trackDesignReviewInteractionIssueFlagged`
// after the comment transaction commits.

export const INTERACTION_ISSUE_CATEGORIES = [
	'drag',
	'scroll',
	'transition',
	'hover',
	'other',
] as const

export type InteractionIssueCategory = (typeof INTERACTION_ISSUE_CATEGORIES)[number]

export function isInteractionIssueCategory(value: unknown): value is InteractionIssueCategory {
	return (
		typeof value === 'string' && (INTERACTION_ISSUE_CATEGORIES as readonly string[]).includes(value)
	)
}

interface InteractionIssueFlaggedProps {
	workspaceId: string
	taskId: string
	designAgentRunId: string | null
	issueCategory: InteractionIssueCategory
	reviewerActorId: string
	prototypeArtifactUrl: string | null
}

export async function trackDesignReviewInteractionIssueFlagged(
	p: InteractionIssueFlaggedProps,
): Promise<void> {
	await capturePosthogEvent('design_review_interaction_issue_flagged', p.workspaceId, {
		task_id: p.taskId,
		design_agent_run_id: p.designAgentRunId,
		issue_category: p.issueCategory,
		reviewer_actor_id: p.reviewerActorId,
		prototype_artifact_url: p.prototypeArtifactUrl,
	})
}
