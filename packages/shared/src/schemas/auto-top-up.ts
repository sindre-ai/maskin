import { z } from 'zod'

/**
 * Auto top-up rule for the prepaid usage-credits balance. Stored under
 * `settings.auto_top_up`; absent means never set up. Written only by
 * PUT /api/billing/auto-top-up and by the charge path in
 * lib/auto-top-up.ts, both with an atomic key write (never a whole-settings save).
 *
 * All amounts are USD cents, the unit of `billing.credit_balance_cents`.
 * There is no live exchange rate in checkout: kroner are shown from the fixed
 * reference 349 DKK = $50 and are always approximate.
 */
export const AUTO_TOP_UP_MIN_THRESHOLD_CENTS = 500
export const AUTO_TOP_UP_MIN_AMOUNT_CENTS = 2_500
/**
 * Largest single auto charge, one cent under the $250 volume-bonus tier
 * (GROWTH_THRESHOLD_USD_MINOR in apps/dev/src/lib/credit-billing.ts), so an
 * unattended charge never earns a bonus tier. Customers who want the bonus
 * buy a bigger pack by hand.
 */
export const AUTO_TOP_UP_MAX_AMOUNT_CENTS = 24_900

export const AUTO_TOP_UP_REFERENCE_USD_CENTS = 5_000
export const AUTO_TOP_UP_REFERENCE_DKK_ORE = 34_900

/** Whole kroner, approximate, from the fixed $50 = 349 DKK reference. */
export function usdCentsToApproxDkk(usdCents: number): number {
	return Math.round(
		(usdCents * AUTO_TOP_UP_REFERENCE_DKK_ORE) / AUTO_TOP_UP_REFERENCE_USD_CENTS / 100,
	)
}

export const AUTO_TOP_UP_FAILURE_REASONS = [
	'card_declined',
	'no_payment_method',
	'authentication_required',
	'charge_error',
] as const

export const autoTopUpRuleSchema = z
	.object({
		enabled: z.boolean(),
		/** Fire when the balance falls below this. */
		threshold_cents: z.number().int().min(AUTO_TOP_UP_MIN_THRESHOLD_CENTS),
		/** What one auto charge adds to the balance. */
		amount_cents: z
			.number()
			.int()
			.min(AUTO_TOP_UP_MIN_AMOUNT_CENTS)
			.max(AUTO_TOP_UP_MAX_AMOUNT_CENTS),
	})
	.refine((v) => v.amount_cents > v.threshold_cents, {
		path: ['amount_cents'],
		message: 'The top-up amount must be larger than the threshold',
	})

export const autoTopUpStatusSchema = z.enum(['ok', 'failed'])

export const autoTopUpResponseSchema = z.object({
	/** null until a rule has been saved. */
	auto_top_up: z
		.object({
			enabled: z.boolean(),
			threshold_cents: z.number().int(),
			amount_cents: z.number().int(),
			/** Whole kroner, approximate (fixed reference, not a live rate). */
			threshold_dkk_approx: z.number().int(),
			amount_dkk_approx: z.number().int(),
			status: autoTopUpStatusSchema,
			failure_reason: z.enum(AUTO_TOP_UP_FAILURE_REASONS).nullable(),
			failed_at: z.number().int().nullable(),
			last_charged_at: z.number().int().nullable(),
		})
		.nullable(),
})

export type AutoTopUpRule = z.infer<typeof autoTopUpRuleSchema>
export type AutoTopUpResponse = z.infer<typeof autoTopUpResponseSchema>
