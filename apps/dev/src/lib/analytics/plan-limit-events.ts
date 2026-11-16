import { capturePosthogEvent } from './posthog'

// Server-side `plan_limit_reached`: a workspace used 100% of its plan, so new
// work is refused or a running session was stopped. Counts, booleans, categories
// and ids only: the plan name and the workspace id, never an amount.
//
// A refused start repeats for every trigger and chat message, so one workspace
// would send the event dozens of times in a period. One per workspace, plan and
// period is kept in memory (a restart sends it once more, which is harmless).
const sent = new Set<string>()
const MAX_REMEMBERED = 5_000

export async function trackPlanLimitReached(p: {
	workspaceId: string
	plan: string
	/** Unix milliseconds of the period end, or null when none is known. */
	periodEnd: number | null
}): Promise<void> {
	const key = `${p.workspaceId}:${p.plan}:${p.periodEnd ?? 'none'}`
	if (sent.has(key)) return
	if (sent.size >= MAX_REMEMBERED) sent.clear()
	sent.add(key)
	await capturePosthogEvent('plan_limit_reached', p.workspaceId, {
		workspace_id: p.workspaceId,
		plan: p.plan,
	})
}

/** Test hook: forget what was sent. */
export function resetPlanLimitEventsForTest(): void {
	sent.clear()
}
