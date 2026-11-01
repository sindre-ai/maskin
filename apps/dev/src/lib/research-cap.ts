import type { Database } from '@maskin/db'
import {
	type MaskinPlan,
	PlanCapExceededError,
	effectivePeriodEnd,
	getWorkspacePlanCap,
	getWorkspacePlanUsdCentsUsage,
} from './llm-routing'
import type { WorkspaceSettings } from './types'

export type ResearchEffort = 'simple' | 'comparison' | 'broad'

/** Default cap per effort level, in USD cents. ASSUMED values: recalibrate after the dry run. */
export const RESEARCH_EFFORT_DEFAULT_CAP_CENTS: Record<ResearchEffort, number> = {
	simple: 100,
	comparison: 400,
	broad: 1_200,
}

const DEFAULT_RESEARCH_MAX_CAP_USD = 15

/** Hard ceiling for one run in USD cents, from RESEARCH_MAX_CAP_USD (default 15). */
export function researchHardCeilingCents(env: NodeJS.ProcessEnv = process.env): number {
	const usd = Number(env.RESEARCH_MAX_CAP_USD)
	const valid = env.RESEARCH_MAX_CAP_USD?.trim() && Number.isFinite(usd) && usd > 0
	return Math.floor((valid ? usd : DEFAULT_RESEARCH_MAX_CAP_USD) * 100)
}

/**
 * The most a research run may spend, in USD cents:
 * min(effort default, caller's max_cost_usd, hard ceiling, plan cap minus plan usage).
 *
 * The plan term is what keeps one run inside the headroom. `checkPlanCap` alone
 * only asks "is usage below the cap", so a $12 run started with 30 cents left
 * could end far past the plan cap.
 *
 * Throws `PlanCapExceededError` (the 402 sessions return) when the headroom is
 * below the simple-effort default cap. Unlike sessions, a prepaid credit balance
 * does not let an over-cap workspace through: research runs are not debited
 * against credits, so letting them run would be unbilled spend.
 *
 * Enterprise workspaces and workspaces not on a Maskin-funded plan are exempt
 * from the plan cap already, so they get the effort default (still lowered by the
 * caller's max and the hard ceiling).
 */
export async function resolveResearchRunCapCents(params: {
	db: Pick<Database, 'select'>
	workspaceId: string
	wsSettings: WorkspaceSettings
	/** Passed in like `checkPlanCap`'s, so the two cannot disagree on enterprise status. */
	enterprise: boolean
	effort: ResearchEffort
	/** The caller's `max_cost_usd`. Can only lower the cap. */
	callerMaxCostUsd?: number
	env?: NodeJS.ProcessEnv
}): Promise<number> {
	const ceilingCents = researchHardCeilingCents(params.env)
	let cap = Math.min(RESEARCH_EFFORT_DEFAULT_CAP_CENTS[params.effort], ceilingCents)

	if (params.callerMaxCostUsd !== undefined) {
		if (!Number.isFinite(params.callerMaxCostUsd) || params.callerMaxCostUsd <= 0) {
			throw new RangeError('max_cost_usd must be a positive number')
		}
		cap = Math.min(cap, Math.floor(Number((params.callerMaxCostUsd * 100).toFixed(6))))
	}

	if (params.enterprise) return cap
	const planCap = getWorkspacePlanCap(params.wsSettings)
	if (planCap === null) return cap

	const billing = params.wsSettings.billing
	// period_start / period_end are Unix SECONDS (Stripe); the usage sum takes ms.
	const periodStartMs =
		typeof billing?.period_start === 'number' ? billing.period_start * 1000 : undefined
	const periodEndMs =
		typeof billing?.period_end === 'number' ? billing.period_end * 1000 : undefined

	const used = await getWorkspacePlanUsdCentsUsage(params.db, params.workspaceId, periodStartMs)
	const headroom = Math.max(0, planCap - used)
	const minRunCents = Math.min(RESEARCH_EFFORT_DEFAULT_CAP_CENTS.simple, ceilingCents)
	if (headroom < minRunCents) {
		throw new PlanCapExceededError({
			plan: (billing?.plan ?? 'trial') as MaskinPlan,
			used,
			cap: planCap,
			periodEnd: effectivePeriodEnd(periodStartMs, periodEndMs),
		})
	}
	return Math.min(cap, headroom)
}
