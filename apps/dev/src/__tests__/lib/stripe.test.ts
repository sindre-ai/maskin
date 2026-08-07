import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createCheckoutSession,
	hardCapForPlan,
	isHandledStripeEvent,
	mapSubscriptionStatus,
	overageItemIdFromSubscription,
	planForPriceId,
	priceIdForPlan,
	priceIdFromSubscription,
	readStripeEnv,
	reportOverageBlock,
	resetStripeClientForTests,
	resolveWorkspaceIdFromEvent,
} from '../../lib/stripe'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_PRO: 'price_pro',
	STRIPE_PRICE_TEAM: 'price_team',
	STRIPE_PRICE_OVERAGE_BLOCK: 'price_overage_block',
	MASKIN_PRO_HARD_CAP_TOKENS: '32000000',
	MASKIN_TEAM_HARD_CAP_TOKENS: '320000000',
}

beforeEach(() => {
	resetStripeClientForTests()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('readStripeEnv', () => {
	it('parses a valid env block', () => {
		const env = readStripeEnv(VALID_ENV)
		expect(env.pricePro).toBe('price_pro')
		expect(env.proHardCapTokens).toBe(32_000_000)
		expect(env.teamHardCapTokens).toBe(320_000_000)
	})

	it('throws when a required var is missing', () => {
		const { STRIPE_PRICE_TEAM: _omit, ...missing } = VALID_ENV
		expect(() => readStripeEnv(missing)).toThrow(/STRIPE_PRICE_TEAM/)
	})

	it('throws when a cap is non-numeric', () => {
		expect(() => readStripeEnv({ ...VALID_ENV, MASKIN_PRO_HARD_CAP_TOKENS: 'abc' })).toThrow(
			/positive integer string/,
		)
	})

	it('throws when a cap is zero or negative', () => {
		expect(() => readStripeEnv({ ...VALID_ENV, MASKIN_TEAM_HARD_CAP_TOKENS: '0' })).toThrow(
			/positive integer string/,
		)
	})
})

describe('priceIdForPlan / planForPriceId / hardCapForPlan', () => {
	const env = readStripeEnv(VALID_ENV)

	it('round-trips plan ↔ price id', () => {
		expect(priceIdForPlan('pro', env)).toBe('price_pro')
		expect(priceIdForPlan('team', env)).toBe('price_team')
		expect(planForPriceId('price_pro', env)).toBe('pro')
		expect(planForPriceId('price_team', env)).toBe('team')
	})

	it('returns null for an unknown price id', () => {
		expect(planForPriceId('price_unknown', env)).toBeNull()
	})

	it('returns the configured token cap for each plan', () => {
		expect(hardCapForPlan('pro', env)).toBe(32_000_000)
		expect(hardCapForPlan('team', env)).toBe(320_000_000)
	})
})

describe('isHandledStripeEvent', () => {
	it('accepts the six events we care about', () => {
		const accepted = [
			'checkout.session.completed',
			'customer.subscription.created',
			'customer.subscription.updated',
			'customer.subscription.deleted',
			'invoice.paid',
			'invoice.payment_failed',
		]
		for (const t of accepted) expect(isHandledStripeEvent(t)).toBe(true)
	})

	it('rejects events outside the allowlist', () => {
		expect(isHandledStripeEvent('charge.succeeded')).toBe(false)
		expect(isHandledStripeEvent('customer.created')).toBe(false)
	})
})

describe('mapSubscriptionStatus', () => {
	it.each([
		['active', 'active'],
		['trialing', 'active'],
		['past_due', 'past_due'],
		['unpaid', 'past_due'],
		['canceled', 'canceled'],
		['incomplete_expired', 'canceled'],
		['incomplete', 'incomplete'],
		['paused', 'incomplete'],
	] as const)('maps stripe status %s → %s', (stripeStatus, expected) => {
		expect(mapSubscriptionStatus(stripeStatus as Stripe.Subscription.Status)).toBe(expected)
	})
})

describe('resolveWorkspaceIdFromEvent', () => {
	it('reads client_reference_id off a checkout.session.completed', () => {
		const event = {
			type: 'checkout.session.completed',
			data: { object: { client_reference_id: 'ws-1', metadata: null } },
		} as unknown as Stripe.Event
		expect(resolveWorkspaceIdFromEvent(event)).toBe('ws-1')
	})

	it('falls back to metadata.workspace_id on subscription events', () => {
		const event = {
			type: 'customer.subscription.updated',
			data: { object: { metadata: { workspace_id: 'ws-2' } } },
		} as unknown as Stripe.Event
		expect(resolveWorkspaceIdFromEvent(event)).toBe('ws-2')
	})

	it('returns null when no link is present', () => {
		const event = {
			type: 'invoice.paid',
			data: { object: { metadata: null } },
		} as unknown as Stripe.Event
		expect(resolveWorkspaceIdFromEvent(event)).toBeNull()
	})
})

describe('priceIdFromSubscription', () => {
	it('extracts the first item price id', () => {
		const sub = {
			items: { data: [{ price: { id: 'price_pro' } }] },
		} as unknown as Stripe.Subscription
		expect(priceIdFromSubscription(sub)).toBe('price_pro')
	})

	it('returns null when items are empty', () => {
		const sub = { items: { data: [] } } as unknown as Stripe.Subscription
		expect(priceIdFromSubscription(sub)).toBeNull()
	})
})

describe('createCheckoutSession', () => {
	const env = readStripeEnv(VALID_ENV)

	it('builds subscription-mode params with the workspace as client_reference_id', async () => {
		const create = vi
			.fn()
			.mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test/checkout/cs_1' })
		const stripe = { checkout: { sessions: { create } } } as unknown as Stripe
		const session = await createCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-1',
				plan: 'pro',
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
			},
			env,
		)
		expect(session.id).toBe('cs_1')
		expect(create).toHaveBeenCalledTimes(1)
		const params = create.mock.calls[0][0] as Stripe.Checkout.SessionCreateParams
		expect(params.mode).toBe('subscription')
		expect(params.client_reference_id).toBe('ws-1')
		expect(params.metadata?.workspace_id).toBe('ws-1')
		expect(params.line_items).toEqual([
			{ price: 'price_pro', quantity: 1 },
			{ price: 'price_overage_block' },
		])
	})

	it('reuses an existing Stripe customer when one is supplied', async () => {
		const create = vi.fn().mockResolvedValue({ id: 'cs_2', url: 'https://stripe.test/cs_2' })
		const stripe = { checkout: { sessions: { create } } } as unknown as Stripe
		await createCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-1',
				plan: 'team',
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
				existingCustomerId: 'cus_existing',
			},
			env,
		)
		const params = create.mock.calls[0][0] as Stripe.Checkout.SessionCreateParams
		expect(params.customer).toBe('cus_existing')
		expect(params.customer_creation).toBeUndefined()
	})
})

describe('overageItemIdFromSubscription', () => {
	const env = readStripeEnv(VALID_ENV)

	it('finds the subscription item carrying the metered overage price', () => {
		const sub = {
			items: {
				data: [
					{ id: 'si_base', price: { id: 'price_pro' } },
					{ id: 'si_overage', price: { id: 'price_overage_block' } },
				],
			},
		} as unknown as Stripe.Subscription
		expect(overageItemIdFromSubscription(sub, env)).toBe('si_overage')
	})

	it('returns null when the subscription has no overage item', () => {
		const sub = {
			items: { data: [{ id: 'si_base', price: { id: 'price_pro' } }] },
		} as unknown as Stripe.Subscription
		expect(overageItemIdFromSubscription(sub, env)).toBeNull()
	})
})

describe('reportOverageBlock', () => {
	it('reports a single meter event with a deterministic idempotency key', async () => {
		const create = vi.fn().mockResolvedValue({ identifier: 'evt_1' })
		const stripe = { billing: { meterEvents: { create } } } as unknown as Stripe
		const result = await reportOverageBlock(stripe, {
			customerId: 'cus_1',
			blockIdempotencyKey: 'ws-1:1700000000:1',
		})
		expect(result.identifier).toBe('evt_1')
		expect(create).toHaveBeenCalledWith(
			{
				event_name: 'maskin_overage_block',
				payload: { value: '1', stripe_customer_id: 'cus_1' },
			},
			{ idempotencyKey: 'ws-1:1700000000:1' },
		)
	})
})
