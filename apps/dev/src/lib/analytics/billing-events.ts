import { capturePosthogEvent } from './posthog'

export type PaidPlan = 'starter' | 'pro'

export type BillingStatus = 'active' | 'past_due' | 'canceled' | 'incomplete'

export type BillingSnapshot = {
	plan: 'trial' | 'starter' | 'pro' | 'byollm'
	status?: BillingStatus
	stripe_subscription_id?: string | null
}

export type BillingEventName =
	| 'subscription_started'
	| 'subscription_canceled'
	| 'subscription_past_due'

export type BillingEmission = {
	event: BillingEventName
	plan: PaidPlan
	stripeSubscriptionId: string
}

const PAID_PLANS = new Set<PaidPlan>(['starter', 'pro'])

const MRR_USD_BY_PLAN: Record<PaidPlan, number> = {
	starter: 20,
	pro: 60,
}

function isPaidPlan(plan: BillingSnapshot['plan']): plan is PaidPlan {
	return PAID_PLANS.has(plan as PaidPlan)
}

export function mrrUsdForPlan(plan: PaidPlan): number {
	return MRR_USD_BY_PLAN[plan]
}

/**
 * Decide which (if any) PostHog event should fire given the prev/next state
 * after a Stripe webhook applies. Returns at most one emission per call —
 * the per-Stripe-event dedup claim upstream guarantees this runs once per
 * delivery, so the only thing this needs to filter is the within-event
 * transition itself.
 *
 * Rules:
 * - `customer.subscription.deleted` → `subscription_canceled` using the plan
 *   we held before the webhook applied (next.plan flips to byollm).
 * - prev.status !== 'active' && next.status === 'active' on a paid plan →
 *   `subscription_started`. This fires on the recovery-from-past_due case
 *   too; HogQL queries dedupe via `min(timestamp) by stripe_subscription_id`.
 * - prev.status === 'active' && next.status === 'past_due' on a paid plan →
 *   `subscription_past_due`.
 */
export function classifyBillingEmission(
	eventType: string,
	prev: BillingSnapshot,
	next: BillingSnapshot,
): BillingEmission | null {
	if (eventType === 'customer.subscription.deleted') {
		if (!isPaidPlan(prev.plan)) return null
		const subId = prev.stripe_subscription_id
		if (!subId) return null
		return { event: 'subscription_canceled', plan: prev.plan, stripeSubscriptionId: subId }
	}

	if (!isPaidPlan(next.plan)) return null
	const subId = next.stripe_subscription_id
	if (!subId) return null

	if (prev.status !== 'active' && next.status === 'active') {
		return { event: 'subscription_started', plan: next.plan, stripeSubscriptionId: subId }
	}
	if (prev.status === 'active' && next.status === 'past_due') {
		return { event: 'subscription_past_due', plan: next.plan, stripeSubscriptionId: subId }
	}
	return null
}

/**
 * Fire-and-forget PostHog emit for a billing transition. Never throws; the
 * webhook handler must not 5xx because analytics is down — Stripe would
 * retry and re-apply the state mutation.
 *
 * `options.timestamp` is passed straight through to PostHog and is used by
 * the backfill script (`scripts/backfill-subscription-events.ts`) to back-
 * date events for subscriptions that landed before instrumentation existed.
 */
export async function emitBillingEvent(
	workspaceId: string,
	emission: BillingEmission,
	options: { timestamp?: Date } = {},
): Promise<void> {
	await capturePosthogEvent(
		emission.event,
		workspaceId,
		{
			workspace_id: workspaceId,
			plan: emission.plan,
			mrr_usd: mrrUsdForPlan(emission.plan),
			stripe_subscription_id: emission.stripeSubscriptionId,
		},
		options,
	)
}
