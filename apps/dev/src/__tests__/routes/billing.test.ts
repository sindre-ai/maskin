import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: vi.fn(() => ({}) as unknown),
		createCheckoutSession: vi.fn(),
	}
})

import { createCheckoutSession } from '../../lib/stripe'
import billingRoutes from '../../routes/billing'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_STARTER: 'price_starter',
	STRIPE_PRICE_PRO: 'price_pro',
	MASKIN_STARTER_HARD_CAP_TOKENS: '32000000',
	MASKIN_PRO_HARD_CAP_TOKENS: '96000000',
}

const setupEnv = () => {
	for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v
}

const clearEnv = () => {
	for (const k of Object.keys(VALID_ENV)) delete process.env[k]
}

beforeEach(() => {
	vi.mocked(createCheckoutSession).mockReset()
	clearEnv()
	setupEnv()
})

describe('POST /api/billing/checkout', () => {
	it('returns the checkout URL on success', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [{ id: workspaceId, settings: {} }]

		vi.mocked(createCheckoutSession).mockResolvedValue({
			id: 'cs_test_1',
			url: 'https://checkout.stripe.com/c/cs_test_1',
		} as Awaited<ReturnType<typeof createCheckoutSession>>)

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{
					plan: 'starter',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({
			url: 'https://checkout.stripe.com/c/cs_test_1',
			session_id: 'cs_test_1',
		})
		expect(createCheckoutSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ workspaceId, plan: 'starter', existingCustomerId: null }),
			expect.anything(),
		)
	})

	it('passes existing stripe_customer_id when present on workspace settings', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'starter', status: 'active', stripe_customer_id: 'cus_99' } },
			},
		]
		vi.mocked(createCheckoutSession).mockResolvedValue({
			id: 'cs_test_2',
			url: 'https://checkout.stripe.com/c/cs_test_2',
		} as Awaited<ReturnType<typeof createCheckoutSession>>)

		await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{
					plan: 'pro',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)

		expect(createCheckoutSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ plan: 'pro', existingCustomerId: 'cus_99' }),
			expect.anything(),
		)
	})

	it('returns 404 when workspace is missing', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{
					plan: 'starter',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': randomUUID() },
			),
		)
		expect(res.status).toBe(404)
	})

	it('returns 400 for an invalid plan', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{
					plan: 'enterprise',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': randomUUID() },
			),
		)
		expect(res.status).toBe(400)
	})

	it('returns 500 when Stripe env is not configured', async () => {
		clearEnv()
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [{ id: workspaceId, settings: {} }]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{
					plan: 'starter',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(500)
	})

	it('returns 500 when Stripe throws while creating the session', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [{ id: workspaceId, settings: {} }]
		vi.mocked(createCheckoutSession).mockRejectedValue(new Error('stripe blew up'))

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/checkout',
				{
					plan: 'starter',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(500)
	})
})
