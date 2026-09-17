import Stripe from 'stripe'
import { parsePositiveIntEnv } from './billing-defaults'
import { logger } from './logger'

type PaidMaskinPlan = 'pro' | 'team'

// ── VAT / Stripe Tax kill switch ────────────────────────────────────────────
//
// MASKIN_VAT_CHECKOUT — env-var-backed on/off for the VAT-correct-checkout bet.
// When off (the default until rollout), every Checkout Session Maskin creates
// keeps the pre-VAT payload shape and the webhook does not touch the new tax_id
// branches — safe rollback is env change + backend restart.
//
// Not registered in FLAGS (apps/dev/src/lib/feature-flags.ts) on purpose: the
// FLAGS registry is user-visible / actor-scoped, resolved by the frontend from
// GET /api/feature-flags. This one gates a backend behaviour change on every
// request, so the boundary is process-env, not per-actor. Ships behind a full
// backend restart via turbo.json globalPassThroughEnv — see the entry there.
const VAT_CHECKOUT_ENV_VAR = 'MASKIN_VAT_CHECKOUT'
export function isVatCheckoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[VAT_CHECKOUT_ENV_VAR]?.trim().toLowerCase() === 'true'
}

// ── Delta 1c — Adaptive Pricing note ───────────────────────────────────────
//
// Adaptive Pricing is on every Checkout Session and remains compatible with
// Stripe Tax once the Delta 1 flags land. Two constraints that follow, for
// the finance/ops team when they read a filing:
//   1. Tax is calculated on the Price currency, NOT the presentment currency.
//      Small reconciliation deltas (single-digit basis points) will appear on
//      filings for non-USD/DKK/EUR presentments — that's Adaptive Pricing's
//      FX layer running underneath Stripe Tax's per-Price calculation.
//   2. Filing conversion uses tax-authority FX, not the customer-facing FX
//      that Adaptive Pricing shows the buyer. Same reason — the two FX
//      pipelines are independent.
// No code change lives at this comment; it exists so a future reader diffing
// a filing against a receipt doesn't chase a phantom bug.

// ── Delta 1b — currency & amount bounds for the custom-amount top-up ──────
//
// Per bet spec, custom top-up amounts are resolved to the customer's currency
// at Checkout Session creation from country → currency table (US→USD,
// EU-member→EUR, DK→DKK, everything else falls back to USD via Adaptive
// Pricing). All three currencies are baked into the maskin_credits_custom
// Price's currency_options; the app-side min/preset/max below matches what
// Stripe's Price object enforces on the outside so a caller can only build
// a Session Stripe will accept.
export type MaskinCreditsCurrency = 'usd' | 'eur' | 'dkk'
export const MASKIN_CREDITS_CURRENCIES: readonly MaskinCreditsCurrency[] = ['usd', 'eur', 'dkk']

/**
 * Type-narrow a raw currency string (from Stripe or an awaiting_vies row) to
 * a `MaskinCreditsCurrency`. Returns `null` for anything else — callers log
 * and fall back to `'usd'` so a rogue value credits raw minor units rather
 * than silently converting through an unknown rate. Defensive per CTO fix #4
 * (10 Sep 2026): the awaiting_vies CHECK constraint guards `kind` but not
 * `currency`, and Stripe's `session.currency` is a lowercase ISO-4217 string
 * that carries no such constraint at all.
 */
export function assertCreditsCurrency(
	value: string | null | undefined,
): MaskinCreditsCurrency | null {
	if (!value) return null
	const lower = value.toLowerCase()
	return (MASKIN_CREDITS_CURRENCIES as readonly string[]).includes(lower)
		? (lower as MaskinCreditsCurrency)
		: null
}

export interface CreditsAmountBounds {
	min: number
	preset: number
	max: number
}
export const CREDIT_TOPUP_BOUNDS_MINOR: Record<MaskinCreditsCurrency, CreditsAmountBounds> = {
	usd: { min: 2500, preset: 5000, max: 500000 },
	dkk: { min: 17500, preset: 34900, max: 3490000 },
	eur: { min: 2250, preset: 4500, max: 450000 },
}


/**
 * Free Trial price (tax-exclusive replacement per bet Delta 3). Held here for
 * reference: the pre-bet archived price `price_1U1RPeK6EV92oY0m3UIAnvnp` is
 * NOT referenced anywhere in the codebase (verified via grep across apps/,
 * packages/, scripts/, .env.example — zero hits). Delta 3's swap is therefore
 * vacuously true on the "no old-price hits" side; naming the replacement here
 * pins the intent so a future signup wiring picks up the tax-exclusive price
 * rather than reintroducing the archived one.
 */
export const MASKIN_FREE_TRIAL_PRICE_ID = 'price_1UB7AaK6EV92oY0mB37GrcOA'
export const MASKIN_FREE_TRIAL_LOOKUP_KEY = 'maskin_free_trial'

/**
 * Delta 1 Checkout Session params — added to EVERY stripe.checkout.sessions.create
 * call built by createCheckoutSession, createCreditCheckoutSession, and
 * createLinkedInAddonCheckoutSession when MASKIN_VAT_CHECKOUT=true.
 *
 * customer_update is only valid when the session already has a Customer
 * attached. Stripe rejects a session at creation with "customer_update can
 * only be used with customer." if customer_update is set while `customer` is
 * not — the "attach the collected billing address to the persisted customer"
 * semantics are meaningless when no persisted customer exists yet. For a
 * first-time buyer (no existingCustomerId), the Customer is minted during
 * Checkout and Stripe populates its address from the collected billing_address
 * automatically, so customer_update must be omitted. Callers pass
 * `hasCustomer` reflecting whether they will also set `params.customer`.
 *
 * Callers spread this into their SessionCreateParams object; do not mutate it.
 */
export function vatCheckoutSessionParams(opts: { hasCustomer: boolean }): Pick<
	Stripe.Checkout.SessionCreateParams,
	'automatic_tax' | 'tax_id_collection' | 'billing_address_collection' | 'customer_update'
> {
	const base = {
		automatic_tax: { enabled: true },
		tax_id_collection: {
			enabled: true,
			required: 'never' as const,
		},
		billing_address_collection: 'required' as const,
	}
	if (!opts.hasCustomer) return base
	return {
		...base,
		customer_update: {
			address: 'auto',
			name: 'auto',
		},
	}
}

export interface StripeEnv {
	secretKey: string
	webhookSecret: string
	pricePro: string
	priceTeam: string
	/** USD cents. */
	proHardCapUsdCents: number
	/** USD cents. */
	teamHardCapUsdCents: number
	/**
	 * Recurring $49/month price for one connected LinkedIn identity. Optional,
	 * unlike the plan prices: a deployment that has not created the Stripe
	 * Product yet still boots, and the add-on simply cannot be billed — every
	 * call site checks for null and says so, rather than throwing at boot and
	 * taking the whole API down over a feature most workspaces do not use.
	 */
	priceLinkedinIdentity: string | null
	/**
	 * Stripe Price id backing the maskin_credits_custom Product — the "customer
	 * picks the number" credit top-up Price whose Product carries the tax_code
	 * Stripe Tax classifies against. Environment-specific (test-mode and
	 * live-mode Products are different Stripe objects with different ids), so
	 * it must come from env rather than the codebase.
	 */
	priceCreditsCustom: string
}

interface CheckoutInputs {
	workspaceId: string
	plan: PaidMaskinPlan
	successUrl: string
	cancelUrl: string
	existingCustomerId?: string | null
}

interface CreditCheckoutInputs {
	workspaceId: string
	/**
	 * Amount to top up, in the minor units of `currency`. Under VAT-checkout
	 * (MASKIN_VAT_CHECKOUT=true) this is passed to the maskin_credits_custom
	 * Price via price_data override so Stripe Tax can classify it; under the
	 * legacy shape it's inlined into an ad-hoc USD-only price_data payload.
	 */
	amountUsdCents: number
	successUrl: string
	cancelUrl: string
	/** Always required — only pro/team workspaces with an active subscription (and thus a Stripe customer) reach this. */
	/** Undefined for a first-time buyer — Stripe Checkout mints the customer
	 *  and the webhook persists the id. */
	existingCustomerId?: string | null
	/**
	 * Currency for the top-up. Only meaningful when MASKIN_VAT_CHECKOUT=true;
	 * ignored on the legacy path (which is USD-only). Defaults to 'usd' to
	 * keep the legacy behaviour byte-identical when the flag is off.
	 */
	currency?: MaskinCreditsCurrency
}

let cachedClient: Stripe | null = null

/**
 * Read Stripe config from the environment. Throws synchronously if any
 * required var is missing so misconfiguration surfaces at boot/first-request,
 * not as a webhook silent-fail much later.
 */
export function readStripeEnv(env: NodeJS.ProcessEnv = process.env): StripeEnv {
	const required = [
		'STRIPE_SECRET_KEY',
		'STRIPE_WEBHOOK_SECRET',
		'STRIPE_PRICE_PRO',
		'STRIPE_PRICE_TEAM',
		'STRIPE_PRICE_CREDITS_CUSTOM',
		'MASKIN_PRO_HARD_CAP_USD_CENTS',
		'MASKIN_TEAM_HARD_CAP_USD_CENTS',
	] as const
	const missing = required.filter((k) => !env[k])
	if (missing.length > 0) {
		throw new Error(`Stripe env vars missing: ${missing.join(', ')}`)
	}
	const parseCapCents = (
		key: 'MASKIN_PRO_HARD_CAP_USD_CENTS' | 'MASKIN_TEAM_HARD_CAP_USD_CENTS',
	) => {
		// Boot-time strict variant: env was just confirmed non-empty by the
		// `missing` check above, so a `null` return from the shared parser means
		// the value is malformed (non-digit, zero, or negative). Throw so misconfig
		// surfaces at first request instead of silently falling back.
		const parsed = parsePositiveIntEnv(key, env)
		if (parsed === null) {
			// Intentionally does not echo the raw env value — billing caps aren't
			// secrets today, but normalising "no env values in thrown errors"
			// prevents the next contributor from leaking a secret-bearing key
			// through error monitors when they reuse this helper.
			throw new Error(`${key} must be a positive integer string`)
		}
		return parsed
	}
	return {
		secretKey: env.STRIPE_SECRET_KEY as string,
		webhookSecret: env.STRIPE_WEBHOOK_SECRET as string,
		pricePro: env.STRIPE_PRICE_PRO as string,
		priceTeam: env.STRIPE_PRICE_TEAM as string,
		proHardCapUsdCents: parseCapCents('MASKIN_PRO_HARD_CAP_USD_CENTS'),
		teamHardCapUsdCents: parseCapCents('MASKIN_TEAM_HARD_CAP_USD_CENTS'),
		priceLinkedinIdentity: env.STRIPE_PRICE_LINKEDIN_IDENTITY || null,
		priceCreditsCustom: env.STRIPE_PRICE_CREDITS_CUSTOM as string,
	}
}

// Pinned explicitly (rather than left to the SDK's bundled default) because
// overage billing depends on the Billing Meters API's current shape — an
// unpinned client silently picking up a newer default apiVersion on a stripe@17
// bump could change meter-event semantics out from under us.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia'

export function getStripeClient(env?: StripeEnv): Stripe {
	if (cachedClient) return cachedClient
	const cfg = env ?? readStripeEnv()
	cachedClient = new Stripe(cfg.secretKey, {
		apiVersion: STRIPE_API_VERSION,
		typescript: true,
	})
	return cachedClient
}

/** Test seam — drop the cached client so a fresh client picks up new env. */
export function resetStripeClientForTests() {
	cachedClient = null
}

export function priceIdForPlan(plan: PaidMaskinPlan, env: StripeEnv): string {
	return plan === 'pro' ? env.pricePro : env.priceTeam
}

/**
 * True when the price is the LinkedIn add-on's. The Stripe webhook uses this
 * to tell an add-on subscription from a plan subscription: both arrive as
 * `customer.subscription.*` on the same customer, and without this check a
 * trial workspace's add-on subscription would overwrite
 * `stripe_subscription_id` (making the add-on look like the plan) and its
 * cancellation would run the plan-downgrade path.
 */
export function isLinkedInAddonPrice(priceId: string | null, env: StripeEnv): boolean {
	if (!priceId || !env.priceLinkedinIdentity) return false
	return priceId === env.priceLinkedinIdentity
}

export function planForPriceId(priceId: string, env: StripeEnv): PaidMaskinPlan | null {
	if (priceId === env.pricePro) return 'pro'
	if (priceId === env.priceTeam) return 'team'
	return null
}

/** Returns the plan's hard cap in USD cents. */
export function hardCapForPlan(plan: PaidMaskinPlan, env: StripeEnv): number {
	return plan === 'pro' ? env.proHardCapUsdCents : env.teamHardCapUsdCents
}

/**
 * Build the args for a Checkout Session that creates a Stripe Customer
 * tagged with our workspaceId. The customer is the durable link between
 * Stripe and Maskin — webhooks fired post-checkout reference the customer,
 * not the session, so we mirror workspace_id into customer.metadata for
 * fallback lookups too.
 */
export async function createCheckoutSession(
	stripe: Stripe,
	inputs: CheckoutInputs,
	env: StripeEnv,
): Promise<Stripe.Checkout.Session> {
	const priceId = priceIdForPlan(inputs.plan, env)
	const params: Stripe.Checkout.SessionCreateParams = {
		mode: 'subscription',
		client_reference_id: inputs.workspaceId,
		success_url: inputs.successUrl,
		cancel_url: inputs.cancelUrl,
		line_items: [{ price: priceId, quantity: 1 }],
		metadata: { workspace_id: inputs.workspaceId, plan: inputs.plan },
		subscription_data: {
			metadata: { workspace_id: inputs.workspaceId, plan: inputs.plan },
		},
		// Delta 1 (VAT bet). Gated by env kill switch. customer_update is
		// conditional on there being a customer to update — see the helper.
		...(isVatCheckoutEnabled()
			? vatCheckoutSessionParams({ hasCustomer: Boolean(inputs.existingCustomerId) })
			: {}),
	}
	if (inputs.existingCustomerId) {
		params.customer = inputs.existingCustomerId
	}
	const session = await stripe.checkout.sessions.create(params)
	logger.info('Stripe checkout session created', {
		workspaceId: inputs.workspaceId,
		plan: inputs.plan,
		sessionId: session.id,
	})
	return session
}

/** Metadata discriminator the webhook uses to route a `mode: 'payment'` checkout.session.completed to the credit-topup branch instead of the subscription-mirroring branch. */
export const CREDIT_TOPUP_METADATA_KIND = 'credit_topup'

/**
 * One-time-payment Checkout Session for a prepaid usage-credits top-up. Uses
 * inline `price_data` (no pre-created Stripe Price) since the amount is
 * user-chosen. Always attached to the workspace's existing Stripe Customer —
 * this flow is only reachable from an already-paid pro/team subscription
 * (see `POST /billing/credits/checkout`), never a fresh checkout.
 */
export async function createCreditCheckoutSession(
	stripe: Stripe,
	inputs: CreditCheckoutInputs,
	env: StripeEnv,
): Promise<Stripe.Checkout.Session> {
	const vatOn = isVatCheckoutEnabled()
	const currency: MaskinCreditsCurrency = vatOn ? (inputs.currency ?? 'usd') : 'usd'

	if (vatOn) {
		// Delta 1b: migrate off ad-hoc `price_data` onto the Stripe-managed
		// `maskin_credits_custom` Price. Stripe Tax can only classify a Price
		// object (via its tax_behavior + product tax code), not an inline
		// price_data blob, so this swap is what unlocks VAT calculation on the
		// custom-amount top-up. Amount is overridden via price_data on top of
		// the Price to keep the "customer chooses the number" behaviour Stripe
		// otherwise takes off a fixed-Price line item.
		const params: Stripe.Checkout.SessionCreateParams = {
			mode: 'payment',
			customer: inputs.existingCustomerId ?? undefined,
			client_reference_id: inputs.workspaceId,
			success_url: inputs.successUrl,
			cancel_url: inputs.cancelUrl,
			line_items: [
				{
					price_data: {
						currency,
						product: (await stripe.prices.retrieve(env.priceCreditsCustom))
							.product as string,
						unit_amount: inputs.amountUsdCents,
						tax_behavior: 'exclusive',
					},
					quantity: 1,
				},
			],
			// Delta 1 payload additions PLUS invoice_creation (payment mode only —
			// subscription mode gets an invoice automatically from Stripe Billing).
			// The invoice PDF is the legally-required document for reverse-charge
			// sales (EU VAT Directive Art. 226(11a)). customer_update is only
			// emitted when a customer is attached — see the helper.
			...vatCheckoutSessionParams({ hasCustomer: Boolean(inputs.existingCustomerId) }),
			invoice_creation: { enabled: true },
			metadata: {
				workspace_id: inputs.workspaceId,
				kind: CREDIT_TOPUP_METADATA_KIND,
				amount_usd_cents: String(inputs.amountUsdCents),
				currency,
			},
		}
		const session = await stripe.checkout.sessions.create(params)
		logger.info('Stripe credit top-up checkout session created (VAT path)', {
			workspaceId: inputs.workspaceId,
			amountUsdCents: inputs.amountUsdCents,
			currency,
			sessionId: session.id,
		})
		return session
	}

	// Legacy path — inline USD-only price_data, no Stripe Tax involvement.
	// Kept byte-identical to pre-VAT behaviour so a flag flip is the only
	// difference between the two shapes at rollback time.
	const session = await stripe.checkout.sessions.create({
		mode: 'payment',
		customer: inputs.existingCustomerId ?? undefined,
		client_reference_id: inputs.workspaceId,
		success_url: inputs.successUrl,
		cancel_url: inputs.cancelUrl,
		line_items: [
			{
				price_data: {
					currency: 'usd',
					product_data: { name: 'Maskin usage credits' },
					unit_amount: inputs.amountUsdCents,
				},
				quantity: 1,
			},
		],
		metadata: {
			workspace_id: inputs.workspaceId,
			kind: CREDIT_TOPUP_METADATA_KIND,
			amount_usd_cents: String(inputs.amountUsdCents),
		},
	})
	logger.info('Stripe credit top-up checkout session created', {
		workspaceId: inputs.workspaceId,
		amountUsdCents: inputs.amountUsdCents,
		sessionId: session.id,
	})
	return session
}

/**
 * Verify a raw webhook payload + signature and return the parsed event.
 * Wraps stripe.webhooks.constructEvent so callers don't pull Stripe types.
 */
export function verifyStripeWebhook(
	stripe: Stripe,
	rawBody: string,
	signature: string,
	webhookSecret: string,
): Stripe.Event {
	return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
}

type StripeEventName =
	| 'checkout.session.completed'
	| 'customer.subscription.created'
	| 'customer.subscription.updated'
	| 'customer.subscription.deleted'
	| 'invoice.paid'
	| 'invoice.payment_failed'
	| 'customer.tax_id.created'
	| 'customer.tax_id.updated'
	| 'customer.tax_id.deleted'
	| 'charge.dispute.created'

// Front-door acceptance list for `POST /api/webhooks/stripe`. An event type
// not in this Set is 200-acked with `unhandled_event_type` and applyEvent
// never runs — see routes/stripe-webhook.ts. The four VAT-bet event types
// (customer.tax_id.* + charge.dispute.created) are listed HERE in Task 1 so
// that Task 2's applyEvent branches can be added without a Task-1-shaped
// front-door regression. Task 2 (VAT webhook state machine) wires the
// applyEvent switch cases; between merges any of these events arriving
// early is handled by the Task 2 branches being present at applyEvent time.
const HANDLED_EVENTS = new Set<string>([
	'checkout.session.completed',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
	'invoice.paid',
	'invoice.payment_failed',
	'customer.tax_id.created',
	'customer.tax_id.updated',
	'customer.tax_id.deleted',
	'charge.dispute.created',
])

export function isHandledStripeEvent(eventType: string): eventType is StripeEventName {
	return HANDLED_EVENTS.has(eventType)
}

/**
 * Resolve the Maskin workspace_id that a Stripe event applies to.
 * Priority: checkout-session.client_reference_id → object.metadata →
 * subscription/customer.metadata. Returns null if no link can be found;
 * the webhook handler is responsible for choosing what to do (we ack with
 * `skipped: true` rather than 4xx so Stripe doesn't keep retrying).
 */
export function resolveWorkspaceIdFromEvent(event: Stripe.Event): string | null {
	const obj = event.data.object as unknown as {
		client_reference_id?: string | null
		metadata?: Record<string, string> | null
	}
	if (event.type === 'checkout.session.completed' && obj.client_reference_id) {
		return obj.client_reference_id
	}
	if (obj.metadata && typeof obj.metadata.workspace_id === 'string' && obj.metadata.workspace_id) {
		return obj.metadata.workspace_id
	}
	// `charge.dispute.created` carries a Dispute object, which references
	// a charge (not a customer or workspace) on its top-level `metadata`.
	// The webhook route's fallback (workspaces.settings.billing.stripe_customer_id)
	// picks this up when the caller resolves the customer id from the charge
	// (see stripe-webhook.ts `customerIdFromEvent` extension); nothing to do
	// here beyond returning null so the fallback path runs.
	// (CTO deliverability review fix #2, 10 Sep 2026.)
	return null
}

/** Map a Stripe subscription's status to the slot we keep on workspace settings. */
export function mapSubscriptionStatus(
	stripeStatus: Stripe.Subscription.Status,
): 'active' | 'past_due' | 'canceled' | 'incomplete' {
	switch (stripeStatus) {
		case 'active':
		case 'trialing':
			return 'active'
		case 'past_due':
		case 'unpaid':
			return 'past_due'
		case 'canceled':
		case 'incomplete_expired':
			return 'canceled'
		default:
			return 'incomplete'
	}
}

/** Extract the price id off the first subscription item — Stripe nests it deeply. */
export function priceIdFromSubscription(subscription: Stripe.Subscription): string | null {
	const item = subscription.items?.data?.[0]
	return item?.price?.id ?? null
}

/**
 * Metadata discriminator marking a Checkout Session (and the subscription it
 * creates) as the LinkedIn Identity add-on's own. A trial workspace has no
 * plan subscription to attach an item to, so it gets a second, single-line
 * subscription — and the webhook has to be able to tell the two apart on the
 * same customer. `isLinkedInAddonPrice` is the primary discriminator; this
 * metadata is the belt-and-braces one, and survives a price id rotation.
 */
export const LINKEDIN_ADDON_METADATA_KIND = 'linkedin_identity_addon'

interface LinkedInAddonCheckoutInputs {
	workspaceId: string
	quantity: number
	successUrl: string
	cancelUrl: string
	/** Reused when the workspace already has a Stripe customer; null creates one. */
	existingCustomerId?: string | null
}

/**
 * Checkout Session for the LinkedIn add-on as a standalone subscription.
 * Only used when the workspace has NO plan subscription (trial) — a pro/team
 * workspace gets the add-on as an item on the plan subscription instead, so
 * the $49 lands on the same invoice as the plan rather than billing
 * separately on its own anniversary.
 */
export async function createLinkedInAddonCheckoutSession(
	stripe: Stripe,
	inputs: LinkedInAddonCheckoutInputs,
	env: StripeEnv,
): Promise<Stripe.Checkout.Session> {
	if (!env.priceLinkedinIdentity) {
		throw new Error('STRIPE_PRICE_LINKEDIN_IDENTITY is not configured')
	}
	const metadata = {
		workspace_id: inputs.workspaceId,
		kind: LINKEDIN_ADDON_METADATA_KIND,
	}
	const params: Stripe.Checkout.SessionCreateParams = {
		mode: 'subscription',
		client_reference_id: inputs.workspaceId,
		success_url: inputs.successUrl,
		cancel_url: inputs.cancelUrl,
		line_items: [{ price: env.priceLinkedinIdentity, quantity: inputs.quantity }],
		metadata,
		subscription_data: { metadata },
		// Delta 1 (VAT bet) also applies to the LinkedIn Identity add-on.
		// Non-blocking spec correction from CTO's 10 Sep deliverability review:
		// the third builder was originally undernamed in the shaping doc.
		...(isVatCheckoutEnabled()
			? vatCheckoutSessionParams({ hasCustomer: Boolean(inputs.existingCustomerId) })
			: {}),
	}
	if (inputs.existingCustomerId) {
		params.customer = inputs.existingCustomerId
	}
	const session = await stripe.checkout.sessions.create(params)
	logger.info('LinkedIn add-on checkout session created', {
		workspaceId: inputs.workspaceId,
		quantity: inputs.quantity,
		sessionId: session.id,
	})
	return session
}
