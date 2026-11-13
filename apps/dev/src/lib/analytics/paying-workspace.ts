// A paid plan that is currently being paid for: pro or team with a Stripe
// subscription that is active or only late (past_due). A trial, a canceled
// subscription, a checkout that is still incomplete and the enterprise BYO
// plan (which has no subscription) do not count.
const PAYING_PLANS = new Set(['pro', 'team'])
const PAYING_STATUSES = new Set(['active', 'past_due'])

/**
 * Whether a workspace has an active paid plan, read from its settings JSON.
 * Anything unreadable counts as not paying, so a revenue split never over-counts.
 */
export function isPayingWorkspace(settings: unknown): boolean {
	if (typeof settings !== 'object' || settings === null) return false
	const billing = (settings as { billing?: unknown }).billing
	if (typeof billing !== 'object' || billing === null) return false
	const { plan, status, stripe_subscription_id } = billing as Record<string, unknown>
	return (
		typeof plan === 'string' &&
		PAYING_PLANS.has(plan) &&
		typeof status === 'string' &&
		PAYING_STATUSES.has(status) &&
		typeof stripe_subscription_id === 'string' &&
		stripe_subscription_id.length > 0
	)
}
