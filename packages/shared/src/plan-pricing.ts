/**
 * The five Maskin plans in kroner, and the one fixed rate that turns kroner into
 * the dollars usage is metered in. Backend (`apps/dev/src/lib/billing-defaults.ts`,
 * the caps that stop spend) and frontend (plan cards, plan picker) both read this
 * file, so a price or an included amount can only change in one place.
 * `scripts/verify-billing-cap-literals.mjs` reads it too and fails CI when any
 * pinned copy of a derived number drifts.
 */

/**
 * The one fixed exchange rate, kroner per dollar (CCO, 9 Nov 2026). Margin of
 * about 77% at full use holds between 6 and 8 kroner per dollar.
 */
export const DKK_PER_USD = 7.0

/** Monthly price in whole kroner, excluding VAT. The trial and enterprise have no price. */
export const PLAN_PRICE_DKK = {
	starter: 99,
	pro: 249,
	team: 549,
	ultra: 1499,
} as const

/**
 * Included usage per plan in whole kroner a month: a fifth of the plan price.
 * The 7-day trial has no price and gets the same 20 as Starter.
 */
export const INCLUDED_USAGE_DKK = {
	trial: 20,
	starter: 20,
	pro: 50,
	team: 110,
	ultra: 300,
} as const

/** Kroner to dollar cents at the fixed rate, rounded to the nearest cent. */
export function dkkToUsdCents(dkk: number): number {
	return Math.round((dkk / DKK_PER_USD) * 100)
}

/** "249 kr", "1.499 kr": Danish thousands separator, no decimals. */
export function formatKroner(dkk: number): string {
	return `${String(Math.round(dkk)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} kr`
}

/**
 * How much of the plan is used, as a whole percent. The one division behind the
 * meter, the banner and the 100% stop: `capCents` is the same stored cap that
 * `checkPlanCap` compares against, so the number shown reaches 100 exactly when
 * work stops. It rounds down (99.6% shows 99%) and is never above 100.
 * Null when no cap is known: a figure is not made up.
 */
export function usagePercent(
	usedCents: number | null | undefined,
	capCents: number | null | undefined,
): number | null {
	if (typeof usedCents !== 'number' || typeof capCents !== 'number') return null
	if (!Number.isFinite(usedCents) || !Number.isFinite(capCents) || capCents <= 0) return null
	if (usedCents >= capCents) return 100
	return Math.max(0, Math.floor((usedCents / capCents) * 100))
}
