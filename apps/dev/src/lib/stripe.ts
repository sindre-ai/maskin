import Stripe from 'stripe'

/**
 * Flat-plan fallback used when Stripe is not configured (STRIPE_SECRET_KEY
 * unset — local dev, CI, pre-billing-instance) or when STRIPE_PRICE_ID is
 * missing/invalid. $120/mo is the mockup's placeholder amount; it is never a
 * real price — the Stripe Price object resolved from STRIPE_PRICE_ID is the
 * source of truth in a configured instance.
 */
export const FLAT_PLAN = {
	planId: 'pro',
	planLabel: 'Pro',
	priceCents: 12000,
	currency: 'usd',
} as const

/**
 * Minimal structural interface for the Stripe surface this app touches.
 * `getStripeClient()` returns a real SDK client cast to this; tests inject a
 * stub. Keeps route types independent of the (large) Stripe SDK types.
 */
export interface StripeLike {
	customers: {
		create: (opts: { email?: string; metadata?: Record<string, string> }) => Promise<{ id: string }>
	}
	paymentIntents: {
		create: (opts: {
			amount: number
			currency: string
			metadata?: Record<string, string>
			automatic_payment_methods: { enabled: boolean }
			customer?: string
		}) => Promise<{ id: string; client_secret: string | null }>
		retrieve: (id: string) => Promise<{
			id: string
			status: string
			amount: number
			currency: string
			metadata: Record<string, string>
		}>
	}
	prices: {
		retrieve: (id: string) => Promise<{
			id: string
			nickname: string | null
			unit_amount: number | null
			currency: string | null
		}>
	}
	billingPortal: {
		sessions: {
			create: (opts: { customer: string; return_url: string }) => Promise<{ url: string }>
		}
	}
}

let cachedStripe: StripeLike | null | undefined

export function getStripeClient(): StripeLike | null {
	const secret = process.env.STRIPE_SECRET_KEY?.trim()
	if (!secret) return null
	if (cachedStripe === undefined) {
		cachedStripe = new Stripe(secret) as unknown as StripeLike
	}
	return cachedStripe
}

/** Clears the cached client (used by tests to toggle configured state). */
export function resetStripeClient(): void {
	cachedStripe = undefined
}

export interface ResolvedPlan {
	planId: string
	planLabel: string
	priceCents: number
	currency: string
	priceId: string | null
}

/**
 * Resolves the monthly plan from the Stripe Price object (STRIPE_PRICE_ID).
 * When Stripe is unconfigured or the price can't be resolved we fall back to
 * FLAT_PLAN — a configured instance must never charge the placeholder, so an
 * unresolvable configured price surfaces an explicit null priceId for the
 * route to reject checkout against.
 */
export async function resolvePlan(): Promise<ResolvedPlan> {
	const stripe = getStripeClient()
	const priceId = process.env.STRIPE_PRICE_ID?.trim() || null
	if (stripe && priceId) {
		try {
			const price = await stripe.prices.retrieve(priceId)
			if (price.unit_amount != null) {
				return {
					planId: (price.nickname ?? FLAT_PLAN.planLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
					planLabel: price.nickname ?? FLAT_PLAN.planLabel,
					priceCents: price.unit_amount,
					currency: price.currency ?? 'usd',
					priceId,
				}
			}
		} catch {
			// Fall through to the flat plan below.
		}
	}
	// A configured instance must never charge the FLAT_PLAN placeholder, so an
	// unresolvable configured price surfaces a null priceId for the route to
	// reject checkout against. (When Stripe is unconfigured the route already
	// 400s before resolvePlan runs — the null here is belt-and-braces.)
	return { ...FLAT_PLAN, priceId: null }
}

/** True when the publishable key is a test-mode key (pk_test_* prefix). */
export function isTestMode(publishableKey: string | null | undefined): boolean {
	return Boolean(publishableKey?.startsWith('pk_test_'))
}

export function getPublishableKey(): string | null {
	return process.env.STRIPE_PUBLISHABLE_KEY?.trim() || null
}
