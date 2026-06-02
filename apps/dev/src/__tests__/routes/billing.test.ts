import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonGet } from '../helpers'

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

describe('GET /api/billing/usage', () => {
	it('returns trial defaults for a workspace with no billing row', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: {} }],
			[], // sessions sum: no rows
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			plan: 'trial',
			status: 'active',
			tokens_used: 0,
			hard_cap_tokens: 100_000,
			stripe_customer_id: null,
			stripe_subscription_id: null,
			period_start: null,
		})
		expect(body.period_resets_in_ms).toBeGreaterThan(0)
	})

	it('sums input + output tokens across maskin_plan sessions since period_start', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		// `billing.period_start` is a Unix SECONDS value — the Stripe webhook
		// writes `subscription.current_period_start` straight through, and
		// Stripe timestamps are seconds. Test uses the production unit.
		const periodStart = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'starter',
							status: 'active',
							hard_cap_tokens: 32_000_000,
							period_start: periodStart,
							stripe_customer_id: 'cus_x',
							stripe_subscription_id: 'sub_x',
						},
					},
				},
			],
			[
				{ inputTokens: 1000, outputTokens: 200 },
				{ inputTokens: 5000, outputTokens: 800 },
				{ inputTokens: null, outputTokens: 50 },
			],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			plan: 'starter',
			status: 'active',
			tokens_used: 7050,
			hard_cap_tokens: 32_000_000,
			period_start: periodStart,
			stripe_customer_id: 'cus_x',
			stripe_subscription_id: 'sub_x',
		})
		// Regression: `period_start` is seconds, the row arithmetic must run in
		// ms. With period_start set 7d ago, the next reset is ~23d out.
		const oneDay = 24 * 60 * 60 * 1000
		expect(body.period_resets_in_ms).toBeGreaterThan(22 * oneDay)
		expect(body.period_resets_in_ms).toBeLessThan(24 * oneDay)
	})

	it('skips the token sum entirely when plan is byollm', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'byollm', status: 'canceled', stripe_subscription_id: null },
					},
				},
			],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			plan: 'byollm',
			status: 'canceled',
			tokens_used: 0,
			period_resets_in_ms: null,
		})
	})

	it('returns 404 when workspace is missing', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': randomUUID() }))
		expect(res.status).toBe(404)
	})

	it('falls back to env-driven cap when a Starter workspace has no hard_cap_tokens', async () => {
		process.env.MASKIN_STARTER_HARD_CAP_TOKENS = '40000000'
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: { billing: { plan: 'starter', status: 'active' } },
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ plan: 'starter', hard_cap_tokens: 40_000_000 })
	})

	it('falls back to literal Starter/Pro defaults when env caps are unset', async () => {
		for (const k of ['MASKIN_STARTER_HARD_CAP_TOKENS', 'MASKIN_PRO_HARD_CAP_TOKENS']) {
			delete process.env[k]
		}
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const starterWs = randomUUID()
		const proWs = randomUUID()
		mockResults.selectQueue = [
			[{ id: starterWs, settings: { billing: { plan: 'starter', status: 'active' } } }],
			[],
			[{ id: proWs, settings: { billing: { plan: 'pro', status: 'active' } } }],
			[],
		]

		const starterRes = await app.request(
			jsonGet('/api/billing/usage', { 'X-Workspace-Id': starterWs }),
		)
		expect(starterRes.status).toBe(200)
		expect(await starterRes.json()).toMatchObject({ plan: 'starter', hard_cap_tokens: 32_000_000 })

		const proRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': proWs }))
		expect(proRes.status).toBe(200)
		expect(await proRes.json()).toMatchObject({ plan: 'pro', hard_cap_tokens: 96_000_000 })
	})

	it('falls back to literal default when the env cap is malformed', async () => {
		process.env.MASKIN_PRO_HARD_CAP_TOKENS = 'not-a-number'
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: { billing: { plan: 'pro', status: 'active' } } }],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ plan: 'pro', hard_cap_tokens: 96_000_000 })
	})

	it('still honours an explicit billing.hard_cap_tokens when set', async () => {
		// Regression: the env/literal fallback only kicks in when the stored
		// value is missing. An explicit positive value always wins.
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'starter', status: 'active', hard_cap_tokens: 12_345_678 },
					},
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ hard_cap_tokens: 12_345_678 })
	})

	it('coerces malformed billing.period_start to null and returns 200', async () => {
		// Regression: a non-integer / non-positive `period_start` (legacy ms
		// values, NaN from a broken webhook write) used to slip past the
		// `safeParse` and trip the response schema's `int().nonnegative()`,
		// surfacing as a 500. Coerce at read time so the row stays useful.
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'starter',
							status: 'active',
							hard_cap_tokens: 32_000_000,
							period_start: -1.5,
						},
					},
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.period_start).toBeNull()
		expect(body).toMatchObject({ plan: 'starter', hard_cap_tokens: 32_000_000 })
	})

	it('floors a fractional period_start so the response schema accepts it', async () => {
		const periodStart = Math.floor(Date.now() / 1000) - 1000
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'starter',
							status: 'active',
							hard_cap_tokens: 32_000_000,
							period_start: periodStart + 0.42,
						},
					},
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ period_start: periodStart })
	})
})
