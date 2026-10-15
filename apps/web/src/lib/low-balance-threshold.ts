/**
 * Pure threshold formula for the low-balance banner (Task 6775ef6c under
 * `bet/6d84-credit-reliability`). Kept in `lib/` so it is trivially unit-
 * testable without a rendered component and shared with the E2E spec's
 * fixture setup — which needs to know the exact cents value that flips the
 * banner on for a stubbed `/api/billing/usage` response.
 *
 * The rule, per spec:
 *
 *   show_banner = credit_balance_cents > 0
 *                 AND credit_balance_cents <= MAX(
 *                   200,  // $2 floor — catches near-empty
 *                   Math.floor(0.20 * sum_topups_last_30d_cents)
 *                 )
 *
 * The floor catches empty workspaces; the 20%-rule catches high-burn
 * workspaces before they zero out. When the parent bet ships
 * `billing.auto_topup.threshold_cents`, replace this call with the stored
 * value — the banner UX does not change.
 */
export const LOW_BALANCE_FLOOR_CENTS = 200

/**
 * Returns the threshold in USD cents that the balance is compared against.
 * `balance <= threshold` (AND `balance > 0`) means the banner shows.
 */
export function computeLowBalanceThresholdCents(sumTopupsLast30dCents: number): number {
	const percentBased = Math.floor(0.2 * Math.max(0, sumTopupsLast30dCents))
	return Math.max(LOW_BALANCE_FLOOR_CENTS, percentBased)
}

export interface LowBalanceDecision {
	/** Whether the banner should render. */
	show: boolean
	/**
	 * The threshold that was compared against, in USD cents. Emitted verbatim
	 * on the `credits_low_balance_banner_shown` PostHog event's
	 * `threshold_used` field so analysis can tell $2-floor triggers apart
	 * from 20%-of-burn triggers.
	 */
	thresholdCents: number
}

export function decideLowBalance(input: {
	creditBalanceCents: number
	sumTopupsLast30dCents: number
}): LowBalanceDecision {
	const thresholdCents = computeLowBalanceThresholdCents(input.sumTopupsLast30dCents)
	const show = input.creditBalanceCents > 0 && input.creditBalanceCents <= thresholdCents
	return { show, thresholdCents }
}
