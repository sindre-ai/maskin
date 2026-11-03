/**
 * Bounds + presets for the prepaid usage-credits top-up flow. Kept in
 * packages/shared (not apps/dev/src/lib) because the frontend buy-credits
 * dialog needs the same min/max to validate + disable its submit button
 * before round-tripping to the backend, mirroring billing-caps.ts.
 */

export const CREDIT_TOPUP_MIN_USD = 10
export const CREDIT_TOPUP_MAX_USD = 500
export const CREDIT_TOPUP_SUGGESTED_USD = [10, 25, 50, 100] as const
