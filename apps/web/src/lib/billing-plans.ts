/**
 * The published plan tiers (mockup 5040–5049).
 *
 * This is marketing copy, not billing state — the amounts here are what the
 * page *advertises*, and they are deliberately not what anything charges. A
 * Maskin instance sells exactly one price, resolved from `STRIPE_PRICE_ID` and
 * returned by `GET /api/billing`, so the tier whose `id` matches that plan is
 * the only card that can start a checkout, and it renders the API's price
 * rather than `amount` below. Every other card is a shop window.
 */
export interface BillingPlanTier {
	id: string
	name: string
	/** Headline figure as written in the mockup — "Free", "$20", "BYOL". */
	amount: string
	/** The qualifier beside it: "/month", "/14 days", or nothing. */
	per: string
	tagline: string
	features: string[]
	/** Tiers sold by arrangement rather than self-serve checkout. */
	contactOnly?: boolean
	/** The one tier the mockup badges. */
	featured?: boolean
}

export const BILLING_PLAN_TIERS: BillingPlanTier[] = [
	{
		id: 'trial',
		name: 'Trial',
		amount: 'Free',
		per: '/14 days',
		tagline: 'Full product, no card. $50 of usage on the house.',
		features: [
			'1 workspace',
			'Unlimited members',
			'$50 of usage included',
			'Full marketplace access',
			'Community support',
		],
	},
	{
		id: 'pro',
		name: 'Pro',
		amount: '$20',
		per: '/month',
		tagline: 'For teams running real workflows day to day.',
		featured: true,
		features: [
			'Unlimited workspaces',
			'Unlimited members',
			'$20 of usage included each month',
			'More usage at cost, no markup',
			'Monthly usage limit you set',
			'Priority support',
			'EU & US data residency',
		],
	},
	{
		id: 'team',
		name: 'Team',
		amount: '$200',
		per: '/month',
		tagline: 'Heavier loops, volume rates, one invoice.',
		features: [
			'Everything in Pro',
			'$200 of usage included each month',
			'Volume rate beyond that',
			'Self-host option',
			'Dedicated onboarding',
			'SLA & invoicing',
		],
	},
	{
		id: 'enterprise',
		name: 'Enterprise',
		amount: 'BYOL',
		per: '',
		tagline: 'Bring your own LLM. Pay by invoice. Full control.',
		contactOnly: true,
		features: [
			'Everything in Team',
			'Bring your own model — any provider',
			'Annual contract, invoice or PO',
			'Self-host on your infra',
			'SSO & RBAC',
			'Dedicated support & SLA',
		],
	},
]
