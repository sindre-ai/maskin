import { usagePercent } from '@maskin/shared'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Server-side `plan_limit_reached`: a workspace used 100% of its plan, so new
// work is refused or a running session was stopped. The plan name, the workspace
// id, and how much of the plan was used (the percent the app shows, plus input and
// output tokens). Never a dollar amount, and never shown to customers: it is there
// so we can watch our heaviest workspaces.
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
	/** Plan usage and plan limit in USD cents, for the percent. Both null leaves the percent out. */
	usedCents?: number | null
	capCents?: number | null
	/**
	 * Reads the period's tokens. Called only when the event is really sent, after the
	 * once-per-period check, so a refused start that repeats costs no extra query.
	 */
	readTokens?: () => Promise<{ inputTokens: number; outputTokens: number }>
}): Promise<void> {
	const key = `${p.workspaceId}:${p.plan}:${p.periodEnd ?? 'none'}`
	if (sent.has(key)) return
	if (sent.size >= MAX_REMEMBERED) sent.clear()
	sent.add(key)
	const percent = usagePercent(p.usedCents, p.capCents)
	let tokens: { inputTokens: number; outputTokens: number } | null = null
	try {
		tokens = (await p.readTokens?.()) ?? null
	} catch (err) {
		// The event is still worth sending without the tokens.
		logger.warn('plan_limit_reached tokens unreadable', {
			workspaceId: p.workspaceId,
			error: String(err),
		})
	}
	await capturePosthogEvent('plan_limit_reached', p.workspaceId, {
		workspace_id: p.workspaceId,
		plan: p.plan,
		...(percent !== null ? { usage_percent: percent } : {}),
		...(tokens ? { input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens } : {}),
	})
}

/** Test hook: forget what was sent. */
export function resetPlanLimitEventsForTest(): void {
	sent.clear()
}
