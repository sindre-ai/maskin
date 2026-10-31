import { capturePosthogEvent } from './posthog'

/** One event per deep_research run, fired once when it ends (spec 7.8). No other research events. */
export const DEEP_RESEARCH_RUN_FINISHED = 'deep_research_run_finished'

export type ResearchRunEndStatus = 'done' | 'capped' | 'failed' | 'interrupted'

export interface ResearchRunFinishedProps {
	actorId: string
	workspaceId: string
	effort: string
	status: ResearchRunEndStatus
	costCents: number
	capCents: number
	searches: number
	extracts: number
	/** Seconds from start to finish. */
	duration: number
	researchers: number
	/** Share of cited sources in tier 1 or 2, 0 to 1. */
	tier12Share: number
}

/**
 * The workspace id is sent so the event follows the workspace's privacy
 * settings like every other backend event. The question and the report are
 * never sent.
 */
export function captureResearchRunFinished(p: ResearchRunFinishedProps): Promise<void> {
	return capturePosthogEvent(DEEP_RESEARCH_RUN_FINISHED, p.actorId, {
		workspace_id: p.workspaceId,
		effort: p.effort,
		status: p.status,
		cost_cents: p.costCents,
		cap_cents: p.capCents,
		searches: p.searches,
		extracts: p.extracts,
		duration: p.duration,
		researchers: p.researchers,
		tier12_share: p.tier12Share,
	})
}
