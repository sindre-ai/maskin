import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	CREDIT_TOPUP_BOUNDS_MINOR,
	CREDIT_TOPUP_METADATA_KIND,
	createCheckoutSession,
	createCreditCheckoutSession,
	hardCapForPrice,
	isHandledStripeEvent,
	mapSubscriptionStatus,
	planForPriceId,
	planFromSubscription,
	priceIdForPlan,
	priceIdsFromSubscription,
	readStripeEnv,
	resetStripeClientForTests,
	resolveWorkspaceIdFromEvent,
	vatCheckoutSessionParams,
} from '../../lib/stripe'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_PRO: 'price_pro',
	STRIPE_PRICE_TEAM: 'price_team',
	STRIPE_PRICE_STARTER_DKK: 'price_starter_dkk',
	STRIPE_PRICE_PRO_DKK: 'price_pro_dkk',
	STRIPE_PRICE_TEAM_DKK: 'price_team_dkk',
	STRIPE_PRICE_ULTRA_DKK: 'price_ultra_dkk',
	STRIPE_PRICE_CREDITS_CUSTOM: 'price_credits_custom_test',
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
		expect(env.priceCreditsCustom).toBe('price_credits_custom_test')
		expect(env.priceDkk).toEqual({
			starter: 'price_starter_dkk',
			pro: 'price_pro_dkk',
			team: 'price_team_dkk',
			ultra: 'price_ultra_dkk',
		})
	})

	it('leaves a kroner price null when its var is unset, and still boots', () => {
		const { STRIPE_PRICE_ULTRA_DKK: _omit, ...missing } = VALID_ENV
		expect(readStripeEnv(missing).priceDkk.ultra).toBeNull()
	})

	it('throws when a required var is missing', () => {
		const { STRIPE_PRICE_TEAM: _omit, ...missing } = VALID_ENV
		expect(() => readStripeEnv(missing)).toThrow(/STRIPE_PRICE_TEAM/)
	})

	it('does not throw when STRIPE_PRICE_CREDITS_CUSTOM is missing — priceCreditsCustom is null', () => {
		const { STRIPE_PRICE_CREDITS_CUSTOM: _omit, ...missing } = VALID_ENV
		const env = readStripeEnv(missing)
		expect(env.priceCreditsCustom).toBeNull()
		expect(env.pricePro).toBe('price_pro')
	})

	it('treats an empty STRIPE_PRICE_CREDITS_CUSTOM as unset', () => {
		expect(
			readStripeEnv({ ...VALID_ENV, STRIPE_PRICE_CREDITS_CUSTOM: '' }).priceCreditsCustom,
		).toBe(null)
	})

	it('does not require the Pro or Team cap env vars', () => {
		expect(() => readStripeEnv(VALID_ENV)).not.toThrow()
	})

	it('ignores the cap env vars: the caps come from code', () => {
		// Regression: a stale prod MASKIN_PRO_HARD_CAP_USD_CENTS of 2000 pinned
		// paying Pro workspaces at $20.
		for (const stale of ['2000', 'abc', '0']) {
			const env = readStripeEnv({
				...VALID_ENV,
				MASKIN_PRO_HARD_CAP_USD_CENTS: stale,
				MASKIN_TEAM_HARD_CAP_USD_CENTS: stale,
			})
			expect(hardCapForPrice('pro', 'price_pro_dkk', env)).toBe(714)
		}
	})
})

describe('priceIdForPlan / planForPriceId / hardCapForPrice', () => {
	const env = readStripeEnv(VALID_ENV)

	it('sells the kroner price for every paid plan', () => {
		expect(priceIdForPlan('starter', env)).toBe('price_starter_dkk')
		expect(priceIdForPlan('pro', env)).toBe('price_pro_dkk')
		expect(priceIdForPlan('team', env)).toBe('price_team_dkk')
		expect(priceIdForPlan('ultra', env)).toBe('price_ultra_dkk')
	})

	it('throws a clear error when a plan has no kroner price in this environment', () => {
		const { STRIPE_PRICE_ULTRA_DKK: _omit, ...missing } = VALID_ENV
		expect(() => priceIdForPlan('ultra', readStripeEnv(missing))).toThrow(
			/STRIPE_PRICE_ULTRA_DKK is not configured/,
		)
	})

	it('maps the four kroner prices and the two old dollar prices to a plan', () => {
		expect(planForPriceId('price_starter_dkk', env)).toBe('starter')
		expect(planForPriceId('price_pro_dkk', env)).toBe('pro')
		expect(planForPriceId('price_team_dkk', env)).toBe('team')
		expect(planForPriceId('price_ultra_dkk', env)).toBe('ultra')
		expect(planForPriceId('price_pro', env)).toBe('pro')
		expect(planForPriceId('price_team', env)).toBe('team')
	})

	it('returns null for an unknown price id', () => {
		expect(planForPriceId('price_unknown', env)).toBeNull()
	})

	it('stores the kroner-derived cap for a kroner price', () => {
		expect(hardCapForPrice('starter', 'price_starter_dkk', env)).toBe(286)
		expect(hardCapForPrice('pro', 'price_pro_dkk', env)).toBe(714)
		expect(hardCapForPrice('team', 'price_team_dkk', env)).toBe(1_571)
		expect(hardCapForPrice('ultra', 'price_ultra_dkk', env)).toBe(4_286)
	})

	it('keeps the old dollar cap while a subscription is on an old dollar price', () => {
		expect(hardCapForPrice('pro', 'price_pro', env)).toBe(4_900)
		expect(hardCapForPrice('team', 'price_team', env)).toBe(20_000)
	})
})

describe('isHandledStripeEvent', () => {
	it('accepts every event the front door needs to admit', () => {
		const accepted = [
			'checkout.session.completed',
			'customer.subscription.created',
			'customer.subscription.updated',
			'customer.subscription.deleted',
			'invoice.paid',
			'invoice.payment_failed',
			// VAT bet (parent a9e19ca4) — Task 1 pre-merges the four event types
			// into HANDLED_EVENTS so Task 2's applyEvent branches can be added
			// without a front-door regression. CTO deliverability fix #1.
			'customer.tax_id.created',
			'customer.tax_id.updated',
			'customer.tax_id.deleted',
			'charge.dispute.created',
		]
		for (const t of accepted) expect(isHandledStripeEvent(t)).toBe(true)
	})

	it('rejects events outside the allowlist', () => {
		expect(isHandledStripeEvent('charge.succeeded')).toBe(false)
		expect(isHandledStripeEvent('customer.created')).toBe(false)
	})
})

describe('vatCheckoutSessionParams (Delta 1)', () => {
	it('returns automatic_tax, tax_id_collection, billing_address_collection, customer_update when a customer is attached', () => {
		const params = vatCheckoutSessionParams({ hasCustomer: true })
		expect(params.automatic_tax).toEqual({ enabled: true })
		expect(params.tax_id_collection).toEqual({ enabled: true, required: 'never' })
		expect(params.billing_address_collection).toBe('required')
		expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' })
	})

	it('omits customer_update for a first-time buyer with no existing Stripe customer', () => {
		// Stripe rejects Checkout with "customer_update can only be used with
		// customer." when customer_update is set without an attached Customer,
		// which kills every first-time paid signup. The other three flags stay
		// on — Stripe still collects the billing address, applies Stripe Tax,
		// and mints the Customer with that address automatically.
		const params = vatCheckoutSessionParams({ hasCustomer: false })
		expect(params.automatic_tax).toEqual({ enabled: true })
		expect(params.tax_id_collection).toEqual({ enabled: true, required: 'never' })
		expect(params.billing_address_collection).toBe('required')
		expect(params.customer_update).toBeUndefined()
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

describe('priceIdsFromSubscription / planFromSubscription', () => {
	const env = readStripeEnv({ ...VALID_ENV, STRIPE_PRICE_LINKEDIN_IDENTITY: 'price_linkedin' })
	const subWith = (...ids: string[]) =>
		({
			items: { data: ids.map((id) => ({ price: { id } })) },
		}) as unknown as Stripe.Subscription

	it('lists every item price id in order', () => {
		expect(priceIdsFromSubscription(subWith('price_a', 'price_b'))).toEqual(['price_a', 'price_b'])
	})

	it('returns an empty list when items are empty', () => {
		expect(priceIdsFromSubscription(subWith())).toEqual([])
	})

	it('finds the plan on the first item', () => {
		expect(planFromSubscription(subWith('price_pro_dkk'), env)).toEqual({
			plan: 'pro',
			priceId: 'price_pro_dkk',
		})
	})

	it('finds the plan when the add-on item comes first', () => {
		expect(planFromSubscription(subWith('price_linkedin', 'price_team_dkk'), env)).toEqual({
			plan: 'team',
			priceId: 'price_team_dkk',
		})
	})

	it('returns null when no item carries a known plan price', () => {
		expect(planFromSubscription(subWith('price_linkedin', 'price_unknown'), env)).toBeNull()
		expect(planFromSubscription(subWith(), env)).toBeNull()
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
		expect(params.line_items).toEqual([{ price: 'price_pro_dkk', quantity: 1 }])
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

describe('createCreditCheckoutSession', () => {
	it('builds a one-time payment-mode session on the maskin_credits_custom Price with Stripe Tax attached', async () => {
		const create = vi
			.fn()
			.mockResolvedValue({ id: 'cs_credit_1', url: 'https://stripe.test/checkout/cs_credit_1' })
		const pricesRetrieve = vi.fn().mockResolvedValue({
			id: 'price_credits_custom_test',
			product: 'prod_maskin_credits_custom',
		})
		const stripe = {
			checkout: { sessions: { create } },
			prices: { retrieve: pricesRetrieve },
		} as unknown as Stripe
		const env = readStripeEnv(VALID_ENV)
		const session = await createCreditCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-1',
				amountUsdCents: 2_500,
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
				existingCustomerId: 'cus_existing',
			},
			env,
		)
		expect(session.id).toBe('cs_credit_1')
		expect(create).toHaveBeenCalledTimes(1)
		expect(pricesRetrieve).toHaveBeenCalledWith('price_credits_custom_test')
		const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams
		expect(params.mode).toBe('payment')
		expect(params.customer).toBe('cus_existing')
		expect(params.client_reference_id).toBe('ws-1')
		expect(params.metadata?.kind).toBe(CREDIT_TOPUP_METADATA_KIND)
		expect(params.metadata?.amount_usd_cents).toBe('2500')
		const lineItem = params.line_items?.[0] as Stripe.Checkout.SessionCreateParams.LineItem
		expect(lineItem.quantity).toBe(1)
		expect(lineItem.price_data?.unit_amount).toBe(2_500)
		expect(lineItem.price_data?.currency).toBe('usd')
		expect(lineItem.price_data?.product).toBe('prod_maskin_credits_custom')
		expect(lineItem.price_data?.tax_behavior).toBe('exclusive')
		// Stripe Tax is unconditional — every checkout emits the Delta 1 payload.
		expect(params.automatic_tax).toEqual({ enabled: true })
		expect(params.tax_id_collection).toEqual({ enabled: true, required: 'never' })
		expect(params.invoice_creation).toEqual({ enabled: true })
	})

	it('throws without calling Stripe when the top-up price env is unset', async () => {
		const create = vi.fn()
		const pricesRetrieve = vi.fn()
		const stripe = {
			checkout: { sessions: { create } },
			prices: { retrieve: pricesRetrieve },
		} as unknown as Stripe
		const { STRIPE_PRICE_CREDITS_CUSTOM: _omit, ...missing } = VALID_ENV
		await expect(
			createCreditCheckoutSession(
				stripe,
				{
					workspaceId: 'ws-1',
					amountUsdCents: 2_500,
					successUrl: 'https://app.test/success',
					cancelUrl: 'https://app.test/cancel',
				},
				readStripeEnv(missing),
			),
		).rejects.toThrow(/STRIPE_PRICE_CREDITS_CUSTOM/)
		expect(pricesRetrieve).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})
})

describe('Delta 1 — Stripe Tax params attached', () => {
	it('createCheckoutSession attaches Delta 1 flags on subscription mode; first-time buyer omits customer_update', async () => {
		const env = readStripeEnv(VALID_ENV)
		const create = vi
			.fn()
			.mockResolvedValue({ id: 'cs_sub_vat', url: 'https://stripe.test/cs_sub_vat' })
		const stripe = { checkout: { sessions: { create } } } as unknown as Stripe
		await createCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-vat',
				plan: 'pro',
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
			},
			env,
		)
		const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams
		expect(params.automatic_tax).toEqual({ enabled: true })
		expect(params.tax_id_collection).toEqual({ enabled: true, required: 'never' })
		expect(params.billing_address_collection).toBe('required')
		// No existingCustomerId → Stripe mints the Customer during Checkout,
		// so customer_update must be omitted or Stripe rejects the session.
		expect(params.customer).toBeUndefined()
		expect(params.customer_update).toBeUndefined()
		// invoice_creation ONLY on payment mode, so subscription mode does not
		// get it here. Stripe Billing auto-invoices subscription sessions.
		expect((params as { invoice_creation?: unknown }).invoice_creation).toBeUndefined()
	})

	it('createCheckoutSession attaches customer_update when a returning customer is passed', async () => {
		const env = readStripeEnv(VALID_ENV)
		const create = vi
			.fn()
			.mockResolvedValue({ id: 'cs_sub_vat_ret', url: 'https://stripe.test/cs_sub_vat_ret' })
		const stripe = { checkout: { sessions: { create } } } as unknown as Stripe
		await createCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-vat',
				plan: 'pro',
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
				existingCustomerId: 'cus_existing',
			},
			env,
		)
		const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams
		expect(params.customer).toBe('cus_existing')
		expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' })
	})

	it('createCreditCheckoutSession swaps to maskin_credits_custom Price + adds invoice_creation', async () => {
		const create = vi
			.fn()
			.mockResolvedValue({ id: 'cs_credit_vat', url: 'https://stripe.test/cs_credit_vat' })
		const pricesRetrieve = vi.fn().mockResolvedValue({
			id: 'price_credits_custom_test',
			product: 'prod_maskin_credits_custom',
		})
		const stripe = {
			checkout: { sessions: { create } },
			prices: { retrieve: pricesRetrieve },
		} as unknown as Stripe

		const env = readStripeEnv(VALID_ENV)
		await createCreditCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-vat',
				amountUsdCents: CREDIT_TOPUP_BOUNDS_MINOR.eur.preset, // 4500 EUR minor
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
				existingCustomerId: 'cus_existing_eu',
				currency: 'eur',
			},
			env,
		)

		expect(pricesRetrieve).toHaveBeenCalledWith('price_credits_custom_test')
		const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams
		expect(params.mode).toBe('payment')
		expect(params.invoice_creation).toEqual({ enabled: true })
		expect(params.automatic_tax).toEqual({ enabled: true })
		expect(params.tax_id_collection).toEqual({ enabled: true, required: 'never' })
		const lineItem = params.line_items?.[0] as Stripe.Checkout.SessionCreateParams.LineItem
		expect(lineItem.price_data?.currency).toBe('eur')
		expect(lineItem.price_data?.unit_amount).toBe(4_500)
		expect(lineItem.price_data?.tax_behavior).toBe('exclusive')
		expect(lineItem.price_data?.product).toBe('prod_maskin_credits_custom')
		expect(params.metadata?.currency).toBe('eur')
	})

	it('defaults currency to usd when caller omits it (Delta 1b)', async () => {
		const create = vi
			.fn()
			.mockResolvedValue({ id: 'cs_credit_vat_usd', url: 'https://stripe.test/cs' })
		const pricesRetrieve = vi.fn().mockResolvedValue({
			id: 'price_credits_custom_test',
			product: 'prod_maskin_credits_custom',
		})
		const stripe = {
			checkout: { sessions: { create } },
			prices: { retrieve: pricesRetrieve },
		} as unknown as Stripe
		const env = readStripeEnv(VALID_ENV)
		await createCreditCheckoutSession(
			stripe,
			{
				workspaceId: 'ws-vat',
				amountUsdCents: 5000,
				successUrl: 'https://app.test/success',
				cancelUrl: 'https://app.test/cancel',
				existingCustomerId: 'cus_x',
			},
			env,
		)
		const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams
		const lineItem = params.line_items?.[0] as Stripe.Checkout.SessionCreateParams.LineItem
		expect(lineItem.price_data?.currency).toBe('usd')
	})
})
