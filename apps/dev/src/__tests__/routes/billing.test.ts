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

// Sentinel cap values that are intentionally NOT the literal defaults
// (32_000_000 / 320_000_000), AND chosen arithmetically far from them so that
// a swapped or off-by-one test value couldn't accidentally satisfy a literal-
// default assertion. Pi / Euler digits keep them memorable.
const PRO_ENV_SENTINEL = '31415926'
const TEAM_ENV_SENTINEL = '27182818'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_PRO: 'price_pro',
	STRIPE_PRICE_TEAM: 'price_team',
	STRIPE_PRICE_OVERAGE_BLOCK: 'price_overage_block',
	MASKIN_PRO_HARD_CAP_TOKENS: PRO_ENV_SENTINEL,
	MASKIN_TEAM_HARD_CAP_TOKENS: TEAM_ENV_SENTINEL,
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
					plan: 'pro',
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
			expect.objectContaining({ workspaceId, plan: 'pro', existingCustomerId: null }),
			expect.anything(),
		)
	})

	it('passes existing stripe_customer_id when present on workspace settings', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				settings: { billing: { plan: 'pro', status: 'active', stripe_customer_id: 'cus_99' } },
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
					plan: 'team',
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)

		expect(createCheckoutSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ plan: 'team', existingCustomerId: 'cus_99' }),
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
					plan: 'pro',
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
					plan: 'pro',
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
					plan: 'pro',
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
			hard_cap_tokens: 8_000_000,
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
							plan: 'pro',
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
			plan: 'pro',
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

	it('falls back to env-driven cap when a Pro workspace has no hard_cap_tokens', async () => {
		process.env.MASKIN_PRO_HARD_CAP_TOKENS = '40000000'
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
		expect(body).toMatchObject({ plan: 'pro', hard_cap_tokens: 40_000_000 })
	})

	it('falls back to env-driven cap when a Team workspace has no hard_cap_tokens', async () => {
		process.env.MASKIN_TEAM_HARD_CAP_TOKENS = '80000000'
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: { billing: { plan: 'team', status: 'active' } },
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ plan: 'team', hard_cap_tokens: 80_000_000 })
	})

	it('falls back to plan default when stored hard_cap_tokens is zero or negative', async () => {
		// Regression: the `billing?.hard_cap_tokens && billing.hard_cap_tokens > 0`
		// guard's false branch was untested. A 0 (or negative) value stored on the
		// workspace must NOT be treated as "an explicit cap" — the env/literal
		// fallback should kick in just like when the field is missing. Also pin
		// `hard_cap_tokens: 1` as the boundary value of the `> 0` guard: a
		// positive integer is honored verbatim, even at the smallest possible
		// value, so callers can't accidentally tip into the fallback by saving 1.
		// And with env unset, the Pro response must equal the literal 32M
		// default — the env-driven test above only proves the false branch hits
		// the sentinel, not the literal that fires in prod when the env is
		// missing.
		for (const k of ['MASKIN_PRO_HARD_CAP_TOKENS']) delete process.env[k]
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const zeroWs = randomUUID()
		const negWs = randomUUID()
		const oneWs = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: zeroWs,
					settings: { billing: { plan: 'pro', status: 'active', hard_cap_tokens: 0 } },
				},
			],
			[],
			[
				{
					id: negWs,
					settings: { billing: { plan: 'team', status: 'active', hard_cap_tokens: -5 } },
				},
			],
			[],
			[
				{
					id: oneWs,
					settings: { billing: { plan: 'pro', status: 'active', hard_cap_tokens: 1 } },
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
			plan: 'pro',
			hard_cap_tokens: 32_000_000,
		})

		const negRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': negWs }))
		expect(negRes.status).toBe(200)
		// Team env is still set to the sentinel by setupEnv — fallback hits env.
		expect(await negRes.json()).toMatchObject({
			plan: 'team',
			hard_cap_tokens: Number(TEAM_ENV_SENTINEL),
		})

		const oneRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': oneWs }))
		expect(oneRes.status).toBe(200)
		expect(await oneRes.json()).toMatchObject({
			plan: 'pro',
			hard_cap_tokens: 1,
		})
	})

	it('falls back to literal Pro/Team defaults when env caps are unset', async () => {
		for (const k of ['MASKIN_PRO_HARD_CAP_TOKENS', 'MASKIN_TEAM_HARD_CAP_TOKENS']) {
			delete process.env[k]
		}
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const proWs = randomUUID()
		const teamWs = randomUUID()
		mockResults.selectQueue = [
			[{ id: proWs, settings: { billing: { plan: 'pro', status: 'active' } } }],
			[],
			[{ id: teamWs, settings: { billing: { plan: 'team', status: 'active' } } }],
			[],
		]

		const proRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': proWs }))
		expect(proRes.status).toBe(200)
		expect(await proRes.json()).toMatchObject({ plan: 'pro', hard_cap_tokens: 32_000_000 })

		const teamRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': teamWs }))
		expect(teamRes.status).toBe(200)
		expect(await teamRes.json()).toMatchObject({ plan: 'team', hard_cap_tokens: 320_000_000 })
	})

	it('falls back to literal default when the env cap is malformed', async () => {
		process.env.MASKIN_TEAM_HARD_CAP_TOKENS = 'not-a-number'
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: { billing: { plan: 'team', status: 'active' } } }],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ plan: 'team', hard_cap_tokens: 320_000_000 })
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
						billing: { plan: 'pro', status: 'active', hard_cap_tokens: 12_345_678 },
					},
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ hard_cap_tokens: 12_345_678 })
	})

	it('uses stored period_end for period_resets_in_ms when present', async () => {
		// When Stripe writes period_end, the resets-in hint should reflect the exact
		// Stripe period boundary — not the 30d approximation from period_start.
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		const periodStart = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
		// period_end set to ~10 days from now (not 23d as the 30d approximation would give)
		const periodEnd = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							hard_cap_tokens: 32_000_000,
							period_start: periodStart,
							period_end: periodEnd,
						},
					},
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		const oneDay = 24 * 60 * 60 * 1000
		// Should be ~10 days, not the 30d-from-start approximation (~23d)
		expect(body.period_resets_in_ms).toBeGreaterThan(9 * oneDay)
		expect(body.period_resets_in_ms).toBeLessThan(11 * oneDay)
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
							plan: 'pro',
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
		expect(body).toMatchObject({ plan: 'pro', hard_cap_tokens: 32_000_000 })
	})

	it('reports overage_enabled and confirmed block counts for a pro workspace over cap', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		const periodStart = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: {
							plan: 'pro',
							status: 'active',
							hard_cap_tokens: 32_000_000,
							period_start: periodStart,
							overage_enabled: true,
						},
					},
				},
			],
			[{ inputTokens: 40_000_000, outputTokens: 0 }], // sessions sum — over cap
			[{ count: 2 }], // confirmed overage blocks this period
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			overage_enabled: true,
			overage_blocks_used: 2,
			overage_usd_charged: 40,
			overage_block_tokens: 32_000_000,
		})
	})

	it('reports zero overage blocks when overage is not enabled', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		const periodStart = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'pro', status: 'active', period_start: periodStart },
					},
				},
			],
			[],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			overage_enabled: false,
			overage_blocks_used: 0,
			overage_usd_charged: 0,
		})
	})

	it('reports no overage fields for a trial workspace', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [[{ id: workspaceId, settings: {} }], []]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			plan: 'trial',
			overage_enabled: false,
			overage_blocks_used: 0,
			overage_usd_charged: 0,
		})
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
							plan: 'pro',
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
