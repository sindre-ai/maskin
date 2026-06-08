import Stripe from 'stripe'
import { parsePositiveIntEnv } from './billing-defaults'
import { logger } from './logger'

export type MaskinPlan = 'starter' | 'pro'

export interface StripeEnv {
	secretKey: string
	webhookSecret: string
	priceStarter: string
	pricePro: string
	starterHardCapTokens: number
	proHardCapTokens: number
}

export interface CheckoutInputs {
	workspaceId: string
	plan: MaskinPlan
	successUrl: string
	cancelUrl: string
	existingCustomerId?: string | null
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
		'STRIPE_PRICE_STARTER',
		'STRIPE_PRICE_PRO',
		'MASKIN_STARTER_HARD_CAP_TOKENS',
		'MASKIN_PRO_HARD_CAP_TOKENS',
	] as const
	const missing = required.filter((k) => !env[k])
	if (missing.length > 0) {
		throw new Error(`Stripe env vars missing: ${missing.join(', ')}`)
	}
	const parseTokenCap = (key: 'MASKIN_STARTER_HARD_CAP_TOKENS' | 'MASKIN_PRO_HARD_CAP_TOKENS') => {
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
		priceStarter: env.STRIPE_PRICE_STARTER as string,
		pricePro: env.STRIPE_PRICE_PRO as string,
		starterHardCapTokens: parseTokenCap('MASKIN_STARTER_HARD_CAP_TOKENS'),
		proHardCapTokens: parseTokenCap('MASKIN_PRO_HARD_CAP_TOKENS'),
	}
}

export function getStripeClient(env?: StripeEnv): Stripe {
	if (cachedClient) return cachedClient
	const cfg = env ?? readStripeEnv()
	cachedClient = new Stripe(cfg.secretKey, {
		// Pin to the SDK's bundled apiVersion. Letting it default protects us
		// from a manual mismatch when stripe@17 is bumped.
		typescript: true,
	})
	return cachedClient
}

/** Test seam — drop the cached client so a fresh client picks up new env. */
export function resetStripeClientForTests() {
	cachedClient = null
}

export function priceIdForPlan(plan: MaskinPlan, env: StripeEnv): string {
	return plan === 'starter' ? env.priceStarter : env.pricePro
}

export function planForPriceId(priceId: string, env: StripeEnv): MaskinPlan | null {
	if (priceId === env.priceStarter) return 'starter'
	if (priceId === env.pricePro) return 'pro'
	return null
}

export function hardCapForPlan(plan: MaskinPlan, env: StripeEnv): number {
	return plan === 'starter' ? env.starterHardCapTokens : env.proHardCapTokens
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
	} else {
		params.customer_creation = 'always'
	}
	const session = await stripe.checkout.sessions.create(params)
	logger.info('Stripe checkout session created', {
		workspaceId: inputs.workspaceId,
		plan: inputs.plan,
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

export type StripeEventName =
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
