import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonGet } from '../helpers'

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: vi.fn(() => ({}) as unknown),
		createCheckoutSession: vi.fn(),
		createBillingPortalSession: vi.fn(),
	}
})

import { createBillingPortalSession, createCheckoutSession } from '../../lib/stripe'
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

// Portal `return_url` is origin-gated against FRONTEND_URL. The portal happy-
// path fixtures all use https://app.test/* URLs, so pin the env to the same
// origin and keep it set even when `clearEnv` drops the Stripe block — the
// "Stripe env not configured" tests still rely on the schema accepting the
// fixture URL before the Stripe check runs.
const FRONTEND_URL_TEST = 'https://app.test'

const setupEnv = () => {
	for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v
	process.env.FRONTEND_URL = FRONTEND_URL_TEST
}

const clearEnv = () => {
	for (const k of Object.keys(VALID_ENV)) delete process.env[k]
}

beforeEach(() => {
	vi.mocked(createCheckoutSession).mockReset()
	vi.mocked(createBillingPortalSession).mockReset()
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

describe('POST /api/billing/portal', () => {
	it('returns the portal URL on success', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'starter', status: 'active', stripe_customer_id: 'cus_42' } },
			},
		]
		vi.mocked(createBillingPortalSession).mockResolvedValue({
			id: 'bps_test_1',
			url: 'https://billing.stripe.com/p/session/test_1',
		} as Awaited<ReturnType<typeof createBillingPortalSession>>)

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'https://app.test/settings/keys' },
				{ 'X-Workspace-Id': workspaceId },
			),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' })
		expect(createBillingPortalSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				workspaceId,
				customerId: 'cus_42',
				returnUrl: 'https://app.test/settings/keys',
			}),
		)
	})

	it('returns 404 when workspace is missing', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'https://app.test/settings/keys' },
				{ 'X-Workspace-Id': randomUUID() },
			),
		)
		expect(res.status).toBe(404)
	})

	it('returns 404 when the workspace has no stripe_customer_id on record', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'trial', status: 'active' } },
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'https://app.test/settings/keys' },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(404)
		expect(createBillingPortalSession).not.toHaveBeenCalled()
	})

	it('returns 500 when Stripe env is not configured', async () => {
		clearEnv()
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'starter', status: 'active', stripe_customer_id: 'cus_42' } },
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'https://app.test/settings/keys' },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(500)
	})

	it('returns 500 when Stripe throws while creating the portal session', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'pro', status: 'active', stripe_customer_id: 'cus_42' } },
			},
		]
		vi.mocked(createBillingPortalSession).mockRejectedValue(new Error('stripe blew up'))

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'https://app.test/settings/keys' },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(500)
	})

	it('returns 500 when Stripe returns a session without a url', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'starter', status: 'active', stripe_customer_id: 'cus_42' } },
			},
		]
		vi.mocked(createBillingPortalSession).mockResolvedValue({
			id: 'bps_test_no_url',
			url: null,
		} as unknown as Awaited<ReturnType<typeof createBillingPortalSession>>)

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'https://app.test/settings/keys' },
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(500)
	})

	it('returns 400 for a malformed return_url', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/portal',
				{ return_url: 'not-a-url' },
				{ 'X-Workspace-Id': randomUUID() },
			),
		)
		expect(res.status).toBe(400)
	})

	// FRONTEND_URL is pinned to https://app.test in beforeEach. URL.origin
	// equality is scheme + host + port (no path/query/userinfo), so any deviation
	// on any of those three must 400 before Stripe is touched. These cases lock
	// that semantic so a future swap to e.g. host-only or hostname-suffix
	// matching can't sneak past review.
	it.each([
		['different host', 'https://attacker.example/landing'],
		['port mismatch', 'https://app.test:8443/x'],
		['subdomain mismatch', 'https://evil.app.test/x'],
	])(
		'returns 400 when return_url origin does not match FRONTEND_URL (%s)',
		async (_label, returnUrl) => {
			const { app } = createTestApp(billingRoutes, '/api/billing')
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/billing/portal',
					{ return_url: returnUrl },
					{ 'X-Workspace-Id': randomUUID() },
				),
			)
			expect(res.status).toBe(400)
			expect(createBillingPortalSession).not.toHaveBeenCalled()
		},
	)
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
})
