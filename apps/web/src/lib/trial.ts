import type { BillingUsageResponse } from '@/lib/api'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What the left-nav trial card says, or null when no card should show.
 *
 * `period_resets_in_ms` is the time left in the current billing period. On the
 * trial plan the period IS the trial (the expiry banner reads it the same way:
 * 0 means the trial has ended), so it is a usable end. Any other plan, or an
 * already-expired trial (the banner owns that state), yields null.
 */
export function trialCardState(
	usage: Pick<BillingUsageResponse, 'plan' | 'period_resets_in_ms'> | undefined,
): { title: string } | null {
	if (!usage || usage.plan !== 'trial') return null
	const ms = usage.period_resets_in_ms
	if (ms == null || ms <= 0) return null
	const days = Math.ceil(ms / DAY_MS)
	if (days <= 1) return { title: ms < DAY_MS ? 'Trial ends today' : 'Trial ends in 1 day' }
	return { title: `Trial ends in ${days} days` }
}
