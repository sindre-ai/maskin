import { afterEach, describe, expect, it, vi } from 'vitest'

// The real getStripeClient() constructs the 'stripe' SDK with STRIPE_SECRET_KEY,
// so mock the constructor (not the module function — resolvePlan calls
// getStripeClient through its own module binding, which a spy cannot intercept).
const { retrievePriceMock } = vi.hoisted(() => ({
	retrievePriceMock: vi.fn(),
}))

vi.mock('stripe', () => ({
	default: class {
		prices = { retrieve: retrievePriceMock }
	},
}))

import {
	FLAT_PLAN,
	getPublishableKey,
	isTestMode,
	resetStripeClient,
	resolvePlan,
} from '../../lib/stripe'

afterEach(() => {
	retrievePriceMock.mockReset()
	vi.unstubAllEnvs()
	resetStripeClient()
})

describe('resolvePlan', () => {
	it('falls back to the flat plan with a null priceId when Stripe is unconfigured', async () => {
		vi.stubEnv('STRIPE_SECRET_KEY', '')
		vi.stubEnv('STRIPE_PRICE_ID', '')

		const plan = await resolvePlan()
		expect(plan.planId).toBe(FLAT_PLAN.planId)
		expect(plan.priceCents).toBe(FLAT_PLAN.priceCents)
		expect(plan.currency).toBe(FLAT_PLAN.currency)
		expect(plan.priceId).toBeNull()
		expect(retrievePriceMock).not.toHaveBeenCalled()
	})

	it('resolves the plan from the Stripe Price when configured', async () => {
		vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_1')
		vi.stubEnv('STRIPE_PRICE_ID', 'price_test_1')
		retrievePriceMock.mockResolvedValue({
			id: 'price_test_1',
			nickname: 'Pro Plus',
			unit_amount: 24000,
			currency: 'usd',
		})

		const plan = await resolvePlan()
		expect(retrievePriceMock).toHaveBeenCalledWith('price_test_1')
		expect(plan).toEqual({
			planId: 'pro-plus',
			planLabel: 'Pro Plus',
			priceCents: 24000,
			currency: 'usd',
			priceId: 'price_test_1',
		})
	})

	it('never charges the placeholder when the configured price cannot be resolved', async () => {
		vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_1')
		vi.stubEnv('STRIPE_PRICE_ID', 'price_test_missing')
		retrievePriceMock.mockRejectedValue(new Error('no such price'))

		const plan = await resolvePlan()
		expect(plan.priceCents).toBe(FLAT_PLAN.priceCents)
		expect(plan.priceId).toBeNull()
	})

	it('treats a price without a unit amount as unresolvable', async () => {
		vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_1')
		vi.stubEnv('STRIPE_PRICE_ID', 'price_test_recurring')
		retrievePriceMock.mockResolvedValue({
			id: 'price_test_recurring',
			nickname: 'Recurring',
			unit_amount: null,
			currency: 'usd',
		})

		const plan = await resolvePlan()
		expect(plan.priceId).toBeNull()
	})
})

describe('isTestMode / getPublishableKey', () => {
	it('detects test-mode publishable keys', () => {
		expect(isTestMode('pk_test_123')).toBe(true)
		expect(isTestMode('pk_live_123')).toBe(false)
		expect(isTestMode(null)).toBe(false)
		expect(isTestMode('')).toBe(false)
	})

	it('reads the publishable key from the environment', () => {
		vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test_abc')
		expect(getPublishableKey()).toBe('pk_test_abc')
	})

	it('returns null when the publishable key is unset or blank', () => {
		vi.stubEnv('STRIPE_PUBLISHABLE_KEY', '')
		expect(getPublishableKey()).toBeNull()
		vi.stubEnv('STRIPE_PUBLISHABLE_KEY', '   ')
		expect(getPublishableKey()).toBeNull()
	})
})
