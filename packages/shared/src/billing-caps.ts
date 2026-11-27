/**
 * Cap tables for the two per-plan workspace limits: how many HUMAN members a
 * single workspace may hold (seat cap) and how many workspaces a single human
 * actor may be `billing_owner_id` of (ownership cap). Both key off the same
 * `workspaces.settings.billing.plan` enum used by `billing-defaults.ts`
 * (backend-only token caps) — kept in packages/shared, not apps/dev/src/lib,
 * because the frontend needs these same numbers for "3 of 5 seats used"
 * quota UI. Agents never count toward either cap.
 */

export const PLAN_TIER_ORDER = ['trial', 'starter', 'pro', 'team', 'ultra', 'enterprise'] as const
export type BillingPlan = (typeof PLAN_TIER_ORDER)[number]

/** The four plans a workspace can buy, cheapest first. Trial and enterprise are not for sale. */
export const PAID_PLANS = ['starter', 'pro', 'team', 'ultra'] as const
export type PaidPlan = (typeof PAID_PLANS)[number]

export function isPaidPlan(plan: string | null | undefined): plan is PaidPlan {
	return (PAID_PLANS as readonly string[]).includes(plan ?? '')
}

/**
 * Max total human members a workspace on this plan may hold. `null` = unlimited.
 * The Free plan (stored as `trial`) is capped at 3. The paid plans are limited
 * only by the seats actually paid for (see `settings.billing.seats`, written by
 * the Stripe webhook); the numbers here are the fallback for a workspace on an
 * old price that predates per-seat billing, so a legacy payer keeps its old cap.
 */
export const SEAT_CAPS: Record<BillingPlan, number | null> = {
	trial: 3,
	starter: 5,
	pro: 5,
	team: 25,
	ultra: 25,
	enterprise: null,
}

/**
 * Max total workspaces a human actor may be `billing_owner_id` of, once their
 * effective tier (the highest plan among workspaces they currently own) is
 * this tier. `null` = unlimited. The numbers match SEAT_CAPS except on the
 * Free tier: Free allows 3 members in a workspace but still one owned
 * workspace. Kept as a separate table so the two caps can diverge freely.
 */
export const OWNERSHIP_CAPS: Record<BillingPlan, number | null> = {
	trial: 1,
	starter: 5,
	pro: 5,
	team: 25,
	ultra: 25,
	enterprise: null,
}

/** Higher of two plan tiers, per PLAN_TIER_ORDER (enterprise > ultra > team > pro > starter > trial). */
export function higherTier(a: BillingPlan, b: BillingPlan): BillingPlan {
	return PLAN_TIER_ORDER.indexOf(a) >= PLAN_TIER_ORDER.indexOf(b) ? a : b
}
