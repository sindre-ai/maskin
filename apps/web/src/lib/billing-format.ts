import type { BillingPlan, BillingUsageResponse } from '@/lib/api'

/**
 * Long-form plan labels used in the settings row (`Trial`, `Starter — $20/mo`,
 * `Pro — $60/mo`, `Bring-your-own`). The banner / composer copy uses
 * `PLAN_LABEL_SHORT` instead — keep both in this module so they don't drift.
 */
export const PLAN_LABEL: Record<BillingPlan, string> = {
	trial: 'Trial',
	starter: 'Starter — $20/mo',
	pro: 'Pro — $60/mo',
	byollm: 'Bring-your-own',
}

/**
 * Short labels for usage copy — "your <label> credits". Empty string for
 * `byollm` so callers can hide themselves if they encounter a BYO workspace.
 */
export const PLAN_LABEL_SHORT: Record<BillingPlan, string> = {
	trial: 'trial',
	starter: 'Starter',
	pro: 'Pro',
	byollm: '',
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
	return `${n}`
}

export function formatResetsIn(ms: number | null): string {
	if (ms == null || ms <= 0) return ''
	const days = Math.floor(ms / (24 * 60 * 60 * 1000))
	if (days > 0) return `resets in ${days}d`
	const hours = Math.floor(ms / (60 * 60 * 1000))
	if (hours > 0) return `resets in ${hours}h`
	return 'resets soon'
}

/** Headroom threshold (15%) below which the near-cap banner appears. */
export const NEAR_CAP_HEADROOM = 0.15

export type BillingUsageState = 'normal' | 'near-cap' | 'over-cap' | 'byo' | 'unknown'

/**
 * Single source of truth for "what state is this workspace in?". The banner,
 * the composer block, and any future surface that gates a paid-plan call all
 * read from here so they can never disagree.
 *
 * Returns `'unknown'` when the usage payload is missing/loading or the cap
 * is unset (pre-Stripe paid plans whose webhook hasn't written `hard_cap_tokens`
 * yet — enforcement fails open in that window too).
 */
export function deriveBillingState(
	usage: BillingUsageResponse | undefined | null,
): BillingUsageState {
	if (!usage) return 'unknown'
	if (usage.plan === 'byollm') return 'byo'

	const cap = usage.hard_cap_tokens
	if (cap == null || cap <= 0) return 'unknown'

	const used = usage.tokens_used
	if (!Number.isFinite(used) || used < 0) return 'unknown'

	if (used >= cap) return 'over-cap'

	const headroom = (cap - used) / cap
	if (headroom < NEAR_CAP_HEADROOM) return 'near-cap'
	return 'normal'
}
