import Stripe from 'stripe'
import { parsePositiveIntEnv } from './billing-defaults'
import { logger } from './logger'

type PaidMaskinPlan = 'pro' | 'team'

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
	amountUsdCents: number
	successUrl: string
	cancelUrl: string
	/** Always required — only pro/team workspaces with an active subscription (and thus a Stripe customer) reach this. */
	existingCustomerId: string
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
): Promise<Stripe.Checkout.Session> {
	const session = await stripe.checkout.sessions.create({
		mode: 'payment',
		customer: inputs.existingCustomerId,
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

const HANDLED_EVENTS = new Set<string>([
	'checkout.session.completed',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
	'invoice.paid',
	'invoice.payment_failed',
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
