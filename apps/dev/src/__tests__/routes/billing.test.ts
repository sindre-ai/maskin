import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonGet } from '../helpers'

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return {
		...actual,
		getStripeClient: vi.fn(() => ({}) as unknown),
		createCheckoutSession: vi.fn(),
		createCreditCheckoutSession: vi.fn(),
	}
})

import { TRIAL_HARD_CAP_DEFAULT_USD_CENTS } from '../../lib/billing-defaults'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { createCheckoutSession, createCreditCheckoutSession } from '../../lib/stripe'
import billingRoutes from '../../routes/billing'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// The billing routes resolve the caller's role from the workspace-scoped
// member lookup, which the mock DB serves from the same static `select`
// result as the workspace row. Spreading these two fields onto that row lets
// one fixture satisfy both reads - the routes are owner/admin-gated now.
const OWNER_CALLER = { role: 'owner', type: 'human' } as const

// Sentinel cap values (USD cents) that are intentionally NOT the literal
// defaults (2_000 / 20_000), AND chosen arithmetically far from them so that
// a swapped or off-by-one test value couldn't accidentally satisfy a literal-
// default assertion. Pi / Euler digits keep them memorable.
const PRO_ENV_SENTINEL = '31415926'
const TEAM_ENV_SENTINEL = '27182818'

const VALID_ENV = {
	STRIPE_SECRET_KEY: 'sk_test_x',
	STRIPE_WEBHOOK_SECRET: 'whsec_x',
	STRIPE_PRICE_PRO: 'price_pro',
	STRIPE_PRICE_TEAM: 'price_team',
	MASKIN_PRO_HARD_CAP_USD_CENTS: PRO_ENV_SENTINEL,
	MASKIN_TEAM_HARD_CAP_USD_CENTS: TEAM_ENV_SENTINEL,
}

const setupEnv = () => {
	for (const [k, v] of Object.entries(VALID_ENV)) process.env[k] = v
}

const clearEnv = () => {
	for (const k of Object.keys(VALID_ENV)) delete process.env[k]
}

beforeEach(() => {
	vi.mocked(createCheckoutSession).mockReset()
	vi.mocked(createCreditCheckoutSession).mockReset()
	clearEnv()
	setupEnv()
	// Reset the memoized flag config so a prior test's FF_* mutations can't
	// leak into the next describe block. Individual tests that need flags on
	// mutate the env AND call _resetFeatureFlagConfig() again before firing
	// the request.
	process.env.FF_TESTER_ACTOR_IDS = undefined
	process.env.FF_TESTER_FEATURES = undefined
	_resetFeatureFlagConfig()
})

describe('POST /api/billing/checkout', () => {
	it('returns the checkout URL on success', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [{ id: workspaceId, ...OWNER_CALLER, settings: {} }]

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
				...OWNER_CALLER,
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
		mockResults.select = [{ id: workspaceId, ...OWNER_CALLER, settings: {} }]

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
		mockResults.select = [{ id: workspaceId, ...OWNER_CALLER, settings: {} }]
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

describe('POST /api/billing/credits/checkout', () => {
	it('returns 400 when the workspace plan is not pro/team', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				...OWNER_CALLER,
				settings: { billing: { plan: 'trial', status: 'active' } },
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/credits/checkout',
				{
					amount_usd_cents: 2_500,
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
		expect(createCreditCheckoutSession).not.toHaveBeenCalled()
	})

	it('returns 400 when the workspace has no stripe_customer_id on file', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				...OWNER_CALLER,
				settings: { billing: { plan: 'pro', status: 'active' } },
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/credits/checkout',
				{
					amount_usd_cents: 2_500,
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when the amount is below the minimum', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				...OWNER_CALLER,
				settings: {
					billing: { plan: 'pro', status: 'active', stripe_customer_id: 'cus_x' },
				},
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/credits/checkout',
				{
					amount_usd_cents: 100,
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when the amount is above the maximum', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				...OWNER_CALLER,
				settings: {
					billing: { plan: 'pro', status: 'active', stripe_customer_id: 'cus_x' },
				},
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/credits/checkout',
				{
					amount_usd_cents: 100_000,
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
	})

	it('returns the checkout URL for an eligible pro workspace', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.select = [
			{
				id: workspaceId,
				...OWNER_CALLER,
				settings: {
					billing: { plan: 'pro', status: 'active', stripe_customer_id: 'cus_x' },
				},
			},
		]
		vi.mocked(createCreditCheckoutSession).mockResolvedValue({
			id: 'cs_credit_1',
			url: 'https://checkout.stripe.com/c/cs_credit_1',
		} as Awaited<ReturnType<typeof createCreditCheckoutSession>>)

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/credits/checkout',
				{
					amount_usd_cents: 2_500,
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({
			url: 'https://checkout.stripe.com/c/cs_credit_1',
			session_id: 'cs_credit_1',
		})
		expect(createCreditCheckoutSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				workspaceId,
				amountUsdCents: 2_500,
				existingCustomerId: 'cus_x',
			}),
		)
	})

	it('returns 404 when workspace is missing', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/billing/credits/checkout',
				{
					amount_usd_cents: 2_500,
					success_url: 'https://app.test/success',
					cancel_url: 'https://app.test/cancel',
				},
				{ 'X-Workspace-Id': randomUUID() },
			),
		)
		expect(res.status).toBe(404)
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
			usd_cents_used: 0,
			hard_cap_usd_cents: TRIAL_HARD_CAP_DEFAULT_USD_CENTS,
			stripe_customer_id: null,
			stripe_subscription_id: null,
			period_start: null,
		})
		expect(body.period_resets_in_ms).toBeGreaterThan(0)
	})

	it('sums dollar cost across maskin_plan sessions since period_start', async () => {
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
							hard_cap_usd_cents: 2_000,
							period_start: periodStart,
							stripe_customer_id: 'cus_x',
							stripe_subscription_id: 'sub_x',
						},
					},
				},
			],
			[
				// Two sessions report their own cost directly ($5.00 + $2.50); a
				// third never reported one and falls back to the flat token rate
				// (16,000 tokens/cent): 16,000 tokens -> 1 cent. Total: 751 cents.
				{ totalCostUsd: '5.00', inputTokens: 1000, outputTokens: 200 },
				{ totalCostUsd: '2.50', inputTokens: 5000, outputTokens: 800 },
				{ totalCostUsd: null, inputTokens: 16_000, outputTokens: 0 },
			],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			plan: 'pro',
			status: 'active',
			usd_cents_used: 751,
			hard_cap_usd_cents: 2_000,
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

	it('skips the token sum entirely when plan is enterprise', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'enterprise', status: 'canceled', stripe_subscription_id: null },
					},
				},
			],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			plan: 'enterprise',
			status: 'canceled',
			usd_cents_used: 0,
			period_resets_in_ms: null,
		})
	})

	it('returns 404 when workspace is missing', async () => {
		const { app } = createTestApp(billingRoutes, '/api/billing')
		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': randomUUID() }))
		expect(res.status).toBe(404)
	})

	it('falls back to env-driven cap when a Pro workspace has no hard_cap_usd_cents', async () => {
		process.env.MASKIN_PRO_HARD_CAP_USD_CENTS = '4000'
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
		expect(body).toMatchObject({ plan: 'pro', hard_cap_usd_cents: 4_000 })
	})

	it('falls back to env-driven cap when a Team workspace has no hard_cap_usd_cents', async () => {
		process.env.MASKIN_TEAM_HARD_CAP_USD_CENTS = '40000'
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
		expect(body).toMatchObject({ plan: 'team', hard_cap_usd_cents: 40_000 })
	})

	it('falls back to plan default when stored hard_cap_usd_cents is zero or negative', async () => {
		// Regression: the `billing?.hard_cap_usd_cents && billing.hard_cap_usd_cents > 0`
		// guard's false branch was untested. A 0 (or negative) value stored on the
		// workspace must NOT be treated as "an explicit cap" — the env/literal
		// fallback should kick in just like when the field is missing. Also pin
		// `hard_cap_usd_cents: 1` as the boundary value of the `> 0` guard: a
		// positive integer is honored verbatim, even at the smallest possible
		// value, so callers can't accidentally tip into the fallback by saving 1.
		// And with env unset, the Pro response must equal the literal $20.00
		// default — the env-driven test above only proves the false branch hits
		// the sentinel, not the literal that fires in prod when the env is
		// missing.
		for (const k of ['MASKIN_PRO_HARD_CAP_USD_CENTS']) delete process.env[k]
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const zeroWs = randomUUID()
		const negWs = randomUUID()
		const oneWs = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: zeroWs,
					settings: { billing: { plan: 'pro', status: 'active', hard_cap_usd_cents: 0 } },
				},
			],
			[],
			[
				{
					id: negWs,
					settings: { billing: { plan: 'team', status: 'active', hard_cap_usd_cents: -5 } },
				},
			],
			[],
			[
				{
					id: oneWs,
					settings: { billing: { plan: 'pro', status: 'active', hard_cap_usd_cents: 1 } },
				},
			],
			[],
		]

		const zeroRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': zeroWs }))
		expect(zeroRes.status).toBe(200)
		// Env is unset, so the fallback path resolves to the literal $20.00
		// default — the actual prod failure mode (no env, stored 0). Proves the
		// route took the `> 0` false branch all the way to the literal.
		expect(await zeroRes.json()).toMatchObject({
			plan: 'pro',
			hard_cap_usd_cents: 2_000,
		})

		const negRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': negWs }))
		expect(negRes.status).toBe(200)
		// Team env is still set to the sentinel by setupEnv — fallback hits env.
		expect(await negRes.json()).toMatchObject({
			plan: 'team',
			hard_cap_usd_cents: Number(TEAM_ENV_SENTINEL),
		})

		const oneRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': oneWs }))
		expect(oneRes.status).toBe(200)
		expect(await oneRes.json()).toMatchObject({
			plan: 'pro',
			hard_cap_usd_cents: 1,
		})
	})

	it('falls back to literal Pro/Team defaults when env caps are unset', async () => {
		for (const k of ['MASKIN_PRO_HARD_CAP_USD_CENTS', 'MASKIN_TEAM_HARD_CAP_USD_CENTS']) {
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
		expect(await proRes.json()).toMatchObject({ plan: 'pro', hard_cap_usd_cents: 2_000 })

		const teamRes = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': teamWs }))
		expect(teamRes.status).toBe(200)
		expect(await teamRes.json()).toMatchObject({ plan: 'team', hard_cap_usd_cents: 20_000 })
	})

	it('falls back to literal default when the env cap is malformed', async () => {
		process.env.MASKIN_TEAM_HARD_CAP_USD_CENTS = 'not-a-number'
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: { billing: { plan: 'team', status: 'active' } } }],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ plan: 'team', hard_cap_usd_cents: 20_000 })
	})

	it('still honours an explicit billing.hard_cap_usd_cents when set', async () => {
		// Regression: the env/literal fallback only kicks in when the stored
		// value is missing. An explicit positive value always wins.
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: {
						billing: { plan: 'pro', status: 'active', hard_cap_usd_cents: 12_345 },
					},
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ hard_cap_usd_cents: 12_345 })
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
							hard_cap_usd_cents: 2_000,
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
							hard_cap_usd_cents: 2_000,
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
		expect(body).toMatchObject({ plan: 'pro', hard_cap_usd_cents: 2_000 })
	})

	it('reports the prepaid credit balance for a pro workspace over cap', async () => {
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
							hard_cap_usd_cents: 2_000,
							period_start: periodStart,
							credit_balance_cents: 4_000,
						},
					},
				},
			],
			[{ inputTokens: 40_000_000, outputTokens: 0 }], // sessions sum — over cap
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ credit_balance_cents: 4_000 })
	})

	it('reports a zero credit balance when none is stored', async () => {
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
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ credit_balance_cents: 0 })
	})

	it('reports a zero credit balance for a trial workspace', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [[{ id: workspaceId, settings: {} }], []]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({ plan: 'trial', credit_balance_cents: 0 })
	})

	it('reports plan enterprise for a enterprise_granted workspace with no billing row', async () => {
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[{ id: workspaceId, settings: {}, enterpriseGranted: true, billingOwnerId: null }],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			plan: 'enterprise',
			usd_cents_used: 0,
			period_resets_in_ms: null,
		})
	})

	it('reports plan enterprise for an enterprise billing owner still stored as trial', async () => {
		const ownerId = randomUUID()
		vi.stubEnv('MASKIN_ENTERPRISE_ACTOR_IDS', ownerId)
		const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
		const workspaceId = randomUUID()
		mockResults.selectQueue = [
			[
				{
					id: workspaceId,
					settings: { billing: { plan: 'trial', status: 'active' } },
					enterpriseGranted: false,
					billingOwnerId: ownerId,
				},
			],
			[],
		]

		const res = await app.request(jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ plan: 'enterprise', period_resets_in_ms: null })
		vi.unstubAllEnvs()
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
							hard_cap_usd_cents: 2_000,
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

	describe('LinkedIn Identity add-on line', () => {
		// The default `actorId` injected by createTestApp is 'test-actor-id'. The
		// flag registry lowercases actor ids at compare time so the string form
		// works even though the real system stores UUIDs.
		const TESTER_ACTOR_ID = 'test-actor-id'

		const enableFlag = () => {
			process.env.FF_TESTER_ACTOR_IDS = TESTER_ACTOR_ID
			process.env.FF_TESTER_FEATURES = 'linkedin-addon-visible'
			_resetFeatureFlagConfig()
		}

		afterEach(() => {
			process.env.FF_TESTER_ACTOR_IDS = undefined
			process.env.FF_TESTER_FEATURES = undefined
			_resetFeatureFlagConfig()
		})

		it('omits the add-on line when the flag is off — the SKU stays hidden by default', async () => {
			// Flag OFF is the ship-default (feature flag is default OFF per the bet).
			// The route short-circuits the count query when the flag resolves to false,
			// so no third selectQueue entry is needed for the integrations count.
			const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
			const workspaceId = randomUUID()
			mockResults.selectQueue = [[{ id: workspaceId, settings: {} }], []]

			const res = await app.request(
				jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({ linkedin_identity_addon: null })
		})

		it('omits the add-on line when the flag is on but zero linkedin-unipile identities are connected', async () => {
			enableFlag()
			const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
			const workspaceId = randomUUID()
			mockResults.selectQueue = [
				[{ id: workspaceId, settings: {} }],
				[], // sessions sum
				[{ n: 0 }], // integrations count → 0
			]

			const res = await app.request(
				jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({ linkedin_identity_addon: null })
		})

		it('shows the add-on line with count × $49 when the flag is on and identities are connected', async () => {
			enableFlag()
			const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
			const workspaceId = randomUUID()
			mockResults.selectQueue = [
				[{ id: workspaceId, settings: {} }],
				[], // sessions sum
				[{ n: 3 }], // integrations count → 3 connected identities
			]

			const res = await app.request(
				jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({
				linkedin_identity_addon: {
					count: 3,
					unit_price_usd_cents: 4900,
					monthly_total_usd_cents: 14_700,
				},
			})
		})

		it('add-on total does NOT flow into usd_cents_used — the SKU is separate from the token ledger', async () => {
			// This is the load-bearing invariant of the bet §Pricing: connectivity
			// (flat per-account) and inference (per-token) MUST be reported as
			// distinct lines. Ledger conflation would either double-bill the
			// customer or eat into their token cap. The token sum comes solely
			// from the sessions query; the $49/identity math never touches it.
			enableFlag()
			const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
			const workspaceId = randomUUID()
			mockResults.selectQueue = [
				[
					{
						id: workspaceId,
						settings: {
							billing: { plan: 'pro', status: 'active', hard_cap_usd_cents: 2_000 },
						},
					},
				],
				[{ totalCostUsd: '1.23', inputTokens: 100, outputTokens: 50 }], // sessions sum → 123 cents
				[{ n: 5 }], // 5 identities × $49 = $245 = 24_500 USD cents; must NOT contribute to usd_cents_used
			]

			const res = await app.request(
				jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.usd_cents_used).toBe(123)
			expect(body.linkedin_identity_addon).toEqual({
				count: 5,
				unit_price_usd_cents: 4900,
				monthly_total_usd_cents: 24_500,
			})
		})

		it('omits the add-on line for a non-tester actor even when the flag id is enabled', async () => {
			// Actor-scoped flag: the flag is listed in FF_TESTER_FEATURES but the
			// caller's actor id is not in FF_TESTER_ACTOR_IDS, so the flag resolves
			// to false for THIS caller. Prevents an early rollout from leaking to
			// non-pilot workspaces via a shared session context.
			process.env.FF_TESTER_ACTOR_IDS = randomUUID() // some other actor
			process.env.FF_TESTER_FEATURES = 'linkedin-addon-visible'
			_resetFeatureFlagConfig()

			const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
			const workspaceId = randomUUID()
			mockResults.selectQueue = [[{ id: workspaceId, settings: {} }], []]

			const res = await app.request(
				jsonGet('/api/billing/usage', { 'X-Workspace-Id': workspaceId }),
			)
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({ linkedin_identity_addon: null })
		})
	})
})
