import type { BillingUsageResponse } from '@/lib/api'
import { usagePercent } from '@maskin/shared'

/** The meter turns to the warning colour at this percent and says work will wait at 100. */
export const PLAN_WARN_PERCENT = 80

export type PlanUsageTone = 'primary' | 'warning' | 'error'

export interface PlanUsageState {
	/** Whole percent of the plan used, 0 to 100. */
	percent: number
	tone: PlanUsageTone
	/** 80% or more: show the "Work will wait at 100%" line. */
	warn: boolean
	/** At 100% and nothing lets new work start, so agents are paused. */
	paused: boolean
}

type UsageForPercent = Pick<
	BillingUsageResponse,
	'plan' | 'status' | 'usd_cents_used' | 'hard_cap_usd_cents' | 'credit_balance_cents'
>

/**
 * What the percent views say. The percent divides by the stored cap the server
 * stops on (`hard_cap_usd_cents`), so the meter reaches 100 exactly when work
 * stops. Null for Enterprise (not metered), when usage has not loaded, and when
 * no cap is known: no figure is shown because none is known.
 *
 * A workspace that still holds a credit balance keeps starting sessions at 100%
 * (the server's rule), so it is at 100 but not paused.
 */
export function planUsageState(usage: UsageForPercent | undefined): PlanUsageState | null {
	if (!usage || usage.plan === 'enterprise') return null
	const percent = usagePercent(usage.usd_cents_used, usage.hard_cap_usd_cents)
	if (percent === null) return null
	const billable = usage.status !== 'past_due' && usage.status !== 'canceled'
	const holdsCredit = billable && usage.credit_balance_cents > 0
	const atLimit = percent >= 100
	return {
		percent,
		tone: atLimit ? 'error' : percent >= PLAN_WARN_PERCENT ? 'warning' : 'primary',
		warn: percent >= PLAN_WARN_PERCENT,
		paused: atLimit && !holdsCredit,
	}
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/** "16 Nov": when the period (the trial, or the month) ends and work can start again. */
export function periodEndLabel(ms: number | null | undefined, now = Date.now()): string | null {
	if (ms == null || ms <= 0) return null
	return DAY_FORMAT.format(new Date(now + ms))
}

/**
 * An agent's cost in a date range as a percent of the plan's limit, for the usage
 * views that no longer show dollars or tokens. Null when the limit is not known.
 */
export function costPercentOfPlan(
	costUsd: number,
	capCents: number | null | undefined,
): number | null {
	if (typeof capCents !== 'number' || !Number.isFinite(capCents) || capCents <= 0) return null
	if (!Number.isFinite(costUsd) || costUsd < 0) return null
	return ((costUsd * 100) / capCents) * 100
}

/** "12%", and "<1%" for a small non-zero share so real use never reads as 0%. */
export function formatPlanPercent(percent: number | null): string {
	if (percent === null) return '—'
	if (percent > 0 && percent < 1) return '<1%'
	return `${Math.round(percent)}%`
}
