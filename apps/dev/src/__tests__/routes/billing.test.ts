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

// Sentinel cap values that are intentionally NOT the literal defaults
// (32_000_000 / 96_000_000), AND chosen arithmetically far from them so that
// a swapped or off-by-one test value couldn't accidentally satisfy a literal-
// default assertion. Pi / Euler digits keep them memorable.
const STARTER_ENV_SENTINEL = '31415926'
const PRO_ENV_SENTINEL = '27182818'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_STARTER: 'price_starter',
	STRIPE_PRICE_PRO: 'price_pro',
	MASKIN_STARTER_HARD_CAP_TOKENS: STARTER_ENV_SENTINEL,
	MASKIN_PRO_HARD_CAP_TOKENS: PRO_ENV_SENTINEL,
}

const setupEnv = () => {
	for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v
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
})

describe('GET /api/billing/usage', () => {
	it('returns trial defaults for a workspace with no billing row', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: {}, createdAt: new Date() }],
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

	it('anchors the trial reset to workspaces.createdAt so the countdown actually decreases', async () => {
		// Regression: previously the trial branch derived both periodStartMs
		// and periodEndMs from Date.now(), so the row always read "resets in
		// ~30d" no matter how old the workspace was. With the createdAt anchor,
		// a workspace 5d into its current 30d cycle shows ~25d remaining.
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: {}, createdAt: fiveDaysAgo }],
			[], // sessions sum: no rows
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		const oneDay = 24 * 60 * 60 * 1000
		expect(body.period_resets_in_ms).toBeGreaterThan(24 * oneDay)
		expect(body.period_resets_in_ms).toBeLessThan(26 * oneDay)
	})

	it('rolls the trial window forward in 30d cycles from createdAt for older workspaces', async () => {
		// A workspace 35d old is 5d into its second 30d cycle, so the row
		// should read ~25d remaining — not "expired", not "reset to ~30d".
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: {}, createdAt: thirtyFiveDaysAgo }],
			[], // sessions sum: no rows
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		const oneDay = 24 * 60 * 60 * 1000
		expect(body.period_resets_in_ms).toBeGreaterThan(24 * oneDay)
		expect(body.period_resets_in_ms).toBeLessThan(26 * oneDay)
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
					createdAt: new Date(),
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
					createdAt: new Date(),
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

	it('falls back to env-driven cap when a Pro workspace has no hard_cap_tokens', async () => {
		process.env.MASKIN_PRO_HARD_CAP_TOKENS = '80000000'
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: { billing: { plan: 'pro', status: 'active' } },
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ plan: 'pro', hard_cap_tokens: 80_000_000 })
	})

	it('falls back to plan default when stored hard_cap_tokens is zero or negative', async () => {
		// Regression: the `billing?.hard_cap_tokens && billing.hard_cap_tokens > 0`
		// guard's false branch was untested. A 0 (or negative) value stored on the
		// workspace must NOT be treated as "an explicit cap" — the env/literal
		// fallback should kick in just like when the field is missing. Also pin
		// `hard_cap_tokens: 1` as the boundary value of the `> 0` guard: a
		// positive integer is honored verbatim, even at the smallest possible
		// value, so callers can't accidentally tip into the fallback by saving 1.
		// And with env unset, the Starter response must equal the literal 32M
		// default — the env-driven test above only proves the false branch hits
		// the sentinel, not the literal that fires in prod when the env is
		// missing.
		for (const k of ['MASKIN_STARTER_HARD_CAP_TOKENS']) delete process.env[k]
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const zeroWs = randomUUID()
		const negWs = randomUUID()
		const oneWs = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: zeroWs,
					settings: { billing: { plan: 'starter', status: 'active', hard_cap_tokens: 0 } },
				},
			],
			[],
			[
				{
					id: negWs,
					settings: { billing: { plan: 'pro', status: 'active', hard_cap_tokens: -5 } },
				},
			],
			[],
			[
				{
					id: oneWs,
					settings: { billing: { plan: 'starter', status: 'active', hard_cap_tokens: 1 } },
				},
			],
			[],
		]

		const zeroRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': zeroWs }))
		expect(zeroRes.status).toBe(200)
		// Env is unset, so the fallback path resolves to the literal 32M default
		// — the actual prod failure mode (no env, stored 0). Proves the route
		// took the `> 0` false branch all the way to the literal.
		expect(await zeroRes.json()).toMatchObject({
			plan: 'starter',
			hard_cap_tokens: 32_000_000,
		})

		const negRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': negWs }))
		expect(negRes.status).toBe(200)
		// Pro env is still set to the sentinel by setupEnv — fallback hits env.
		expect(await negRes.json()).toMatchObject({
			plan: 'pro',
			hard_cap_tokens: Number(PRO_ENV_SENTINEL),
		})

		const oneRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': oneWs }))
		expect(oneRes.status).toBe(200)
		expect(await oneRes.json()).toMatchObject({
			plan: 'starter',
			hard_cap_tokens: 1,
		})
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
