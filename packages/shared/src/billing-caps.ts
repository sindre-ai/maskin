/**
 * Cap tables for the two per-plan workspace limits: how many HUMAN members a
 * single workspace may hold (seat cap) and how many workspaces a single human
 * actor may be `billing_owner_id` of (ownership cap). Both key off the same
 * `workspaces.settings.billing.plan` enum used by `billing-defaults.ts`
 * (backend-only token caps) — kept in packages/shared, not apps/dev/src/lib,
 * because the frontend needs these same numbers for "3 of 5 seats used"
 * quota UI. Agents never count toward either cap.
 */

export const PLAN_TIER_ORDER = ['trial', 'pro', 'team', 'byollm'] as const
export type BillingPlan = (typeof PLAN_TIER_ORDER)[number]

/** Max total human members a workspace on this plan may hold. `null` = unlimited. */
export const SEAT_CAPS: Record<BillingPlan, number | null> = {
	trial: 1,
	pro: 5,
	team: 25,
	byollm: null,
}

/**
 * Max total workspaces a human actor may be `billing_owner_id` of, once their
 * effective tier (the highest plan among workspaces they currently own) is
 * this tier. `null` = unlimited. Deliberately the same numbers as SEAT_CAPS
 * today — kept as a separate table (not a shared constant) so the two caps
 * can diverge later without every call site needing to change.
 */
export const OWNERSHIP_CAPS: Record<BillingPlan, number | null> = {
	trial: 1,
	pro: 5,
	team: 25,
	byollm: null,
}

/** Higher of two plan tiers, per PLAN_TIER_ORDER (byollm > team > pro > trial). */
export function higherTier(a: BillingPlan, b: BillingPlan): BillingPlan {
	return PLAN_TIER_ORDER.indexOf(a) >= PLAN_TIER_ORDER.indexOf(b) ? a : b
}
