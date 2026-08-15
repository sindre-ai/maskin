import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Helper: create a Response object for fetch mock
function jsonResponse(data: unknown, status = 200, statusText = 'OK'): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		json: () => Promise.resolve(data),
		text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
		headers: new Headers({ 'content-type': 'application/json' }),
		redirected: false,
		type: 'basic' as ResponseType,
		url: '',
		clone: () => jsonResponse(data, status, statusText),
		body: null,
		bodyUsed: false,
		blob: () => Promise.reject(new Error('not implemented')),
		arrayBuffer: () => Promise.reject(new Error('not implemented')),
		formData: () => Promise.reject(new Error('not implemented')),
	} as Response
}

// Anthropic usage response factory
function anthropicResponse(usage: Array<{ metric: string; value: number }>) {
	return { usage }
}

// OpenRouter credits response factory
function openRouterSuccess(creditsUsed: number, creditsLimit: number) {
	return {
		data: {
			credits_used: creditsUsed,
			credits_used_total: 5000,
			credits_limit: creditsLimit,
		},
	}
}

// Set up fetch mock that dispatches by URL
function mockFetch(
	anthropic: { status?: number; data?: unknown } | null,
	openRouter: { status?: number; data?: unknown } | null,
) {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			if (url.includes('api.anthropic.com')) {
				if (anthropic === null) {
					return Promise.reject(new Error('Network error'))
				}
				return Promise.resolve(
					jsonResponse(anthropic.data ?? anthropicResponse([]), anthropic.status ?? 200),
				)
			}
			if (url.includes('openrouter.ai')) {
				if (openRouter === null) {
					return Promise.reject(new Error('Network error'))
				}
				return Promise.resolve(
					jsonResponse(openRouter.data ?? openRouterSuccess(0, 100), openRouter.status ?? 200),
				)
			}
			return Promise.resolve(jsonResponse({}, 404))
		}),
	)
}

describe('quota poller — integration', () => {
	let poller: typeof import('../poller')

	beforeAll(async () => {
		process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-ant-test-key-12345'
		process.env.OPENROUTER_API_KEY = 'sk-or-test-key-12345'
		process.env.ANTHROPIC_WEEKLY_CEILING = '1000'
		process.env.ANTHROPIC_5H_CEILING = '150'
		process.env.THRESHOLD_PCT = '80'

		poller = await import('../poller')
	})

	beforeEach(() => {
		vi.stubGlobal('console', {
			log: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	afterAll(() => {
		Reflect.deleteProperty(process.env, 'ANTHROPIC_ADMIN_API_KEY')
		Reflect.deleteProperty(process.env, 'OPENROUTER_API_KEY')
		Reflect.deleteProperty(process.env, 'ANTHROPIC_WEEKLY_CEILING')
		Reflect.deleteProperty(process.env, 'ANTHROPIC_5H_CEILING')
		Reflect.deleteProperty(process.env, 'THRESHOLD_PCT')
	})

	/* ------------------------------------------------------------------ */
	/*  AC-U3: All below 80% — no alert                                   */
	/* ------------------------------------------------------------------ */

	it('AC-U3: returns quotas below threshold when all routes are under 80%', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 500 },
					{ metric: 'total_usage_5h', value: 30 },
				]),
			},
			{
				data: openRouterSuccess(500, 2000),
			},
		)

		const result = await poller.main()

		expect(result.errors).toHaveLength(0)
		expect(result.any_exceeded).toBe(false)
		expect(Object.keys(result.quotas)).toEqual([
			'claude_weekly',
			'claude_5h_overage',
			'openrouter_daily',
		])

		// Claude weekly: 500/1000 = 50%
		expect(result.quotas.claude_weekly.headroom_pct).toBe(50)
		expect(result.quotas.claude_weekly.exceeded).toBe(false)

		// Claude 5h: 30/150 = 20%
		expect(result.quotas.claude_5h_overage.headroom_pct).toBe(20)
		expect(result.quotas.claude_5h_overage.exceeded).toBe(false)

		// OpenRouter: 500/2000 = 25%
		expect(result.quotas.openrouter_daily.headroom_pct).toBe(25)
		expect(result.quotas.openrouter_daily.exceeded).toBe(false)
	})

	/* ------------------------------------------------------------------ */
	/*  AC-U2: ≥80% triggers alert flag                                   */
	/* ------------------------------------------------------------------ */

	it('AC-U2: sets any_exceeded when all routes are at or above 80%', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 900 },
					{ metric: 'total_usage_5h', value: 140 },
				]),
			},
			{
				data: openRouterSuccess(1800, 2000),
			},
		)

		const result = await poller.main()

		expect(result.errors).toHaveLength(0)
		expect(result.any_exceeded).toBe(true)

		// Claude weekly: 900/1000 = 90%
		expect(result.quotas.claude_weekly.headroom_pct).toBe(90)
		expect(result.quotas.claude_weekly.exceeded).toBe(true)

		// Claude 5h: 140/150 = 93.3%
		expect(result.quotas.claude_5h_overage.headroom_pct).toBe(93.3)
		expect(result.quotas.claude_5h_overage.exceeded).toBe(true)

		// OpenRouter: 1800/2000 = 90%
		expect(result.quotas.openrouter_daily.headroom_pct).toBe(90)
		expect(result.quotas.openrouter_daily.exceeded).toBe(true)
	})

	it('AC-U2: sets any_exceeded when only one route is above threshold', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 950 },
					{ metric: 'total_usage_5h', value: 30 },
				]),
			},
			{
				data: openRouterSuccess(500, 2000),
			},
		)

		const result = await poller.main()

		expect(result.any_exceeded).toBe(true)
		expect(result.quotas.claude_weekly.exceeded).toBe(true) // 95%
		expect(result.quotas.claude_5h_overage.exceeded).toBe(false) // 20%
		expect(result.quotas.openrouter_daily.exceeded).toBe(false) // 25%
	})

	it('AC-U2: exactly at 80% is considered exceeded', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 800 },
					{ metric: 'total_usage_5h', value: 120 },
				]),
			},
			{
				data: openRouterSuccess(1600, 2000),
			},
		)

		const result = await poller.main()

		expect(result.any_exceeded).toBe(true)
		expect(result.quotas.claude_weekly.exceeded).toBe(true) // 80%
		expect(result.quotas.claude_5h_overage.exceeded).toBe(true) // 80%
		expect(result.quotas.openrouter_daily.exceeded).toBe(true) // 80%
		expect(result.quotas.claude_weekly.headroom_pct).toBe(80)
	})

	/* ------------------------------------------------------------------ */
	/*  AC-T1: Invalid API key — structured error, no event               */
	/* ------------------------------------------------------------------ */

	it('AC-T1: returns structured error when Anthropic API key is invalid (401)', async () => {
		mockFetch(
			{
				status: 401,
				data: { error: { type: 'authentication_error', message: 'Invalid API key' } },
			},
			{ data: openRouterSuccess(500, 2000) },
		)

		const result = await poller.main()

		// Anthropic failed so no claude quotas
		expect(result.quotas.claude_weekly).toBeUndefined()
		expect(result.quotas.claude_5h_overage).toBeUndefined()
		// OpenRouter still succeeded
		expect(result.quotas.openrouter_daily).toBeDefined()

		// There should be an error entry for claude
		const claudeError = result.errors.find((e) => e.route === 'claude')
		expect(claudeError).toBeDefined()
		expect(claudeError?.code).toBe('ANTHROPIC_FETCH_FAILED')
		expect(claudeError?.message).toContain('Failed to fetch')

		// No error for OpenRouter
		const orError = result.errors.find((e) => e.route === 'openrouter')
		expect(orError).toBeUndefined()
	})

	it('AC-T1: returns structured error when OpenRouter API key is invalid (403)', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 500 },
					{ metric: 'total_usage_5h', value: 30 },
				]),
			},
			{ status: 403, data: { error: { code: 403, message: 'Forbidden' } } },
		)

		const result = await poller.main()

		// Claude quotas present
		expect(result.quotas.claude_weekly).toBeDefined()
		expect(result.quotas.claude_5h_overage).toBeDefined()
		// OpenRouter failed
		expect(result.quotas.openrouter_daily).toBeUndefined()

		const orError = result.errors.find((e) => e.route === 'openrouter')
		expect(orError).toBeDefined()
		expect(orError?.code).toBe('OPENROUTER_FETCH_FAILED')
	})

	it('AC-T1: handles both providers failing with 401', async () => {
		mockFetch(
			{ status: 401, data: { error: { type: 'authentication_error' } } },
			{ status: 401, data: { error: { code: 401, message: 'Unauthorized' } } },
		)

		const result = await poller.main()

		expect(Object.keys(result.quotas)).toHaveLength(0)
		expect(result.errors).toHaveLength(2)
		expect(result.errors.map((e) => e.route).sort()).toEqual(['claude', 'openrouter'])
		expect(result.any_exceeded).toBe(false)
	})

	/* ------------------------------------------------------------------ */
	/*  AC-T2: Recovery — was above, now below                            */
	/* ------------------------------------------------------------------ */

	it('AC-T2: returns exceeded=false when data drops below threshold after being above', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 300 },
					{ metric: 'total_usage_5h', value: 20 },
				]),
			},
			{
				data: openRouterSuccess(200, 2000),
			},
		)

		const result = await poller.main()

		expect(result.any_exceeded).toBe(false)
		expect(result.quotas.claude_weekly.headroom_pct).toBe(30) // 300/1000
		expect(result.quotas.claude_weekly.exceeded).toBe(false)
		expect(result.quotas.openrouter_daily.headroom_pct).toBe(10) // 200/2000
		expect(result.quotas.openrouter_daily.exceeded).toBe(false)
	})

	/* ------------------------------------------------------------------ */
	/*  AC-U1 + AC-T3: Result shape — all PostHog-required fields present */
	/* ------------------------------------------------------------------ */

	it('AC-U1 + AC-T3: PollResult contains all fields needed for PostHog quota_alert_fired event', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 850 },
					{ metric: 'total_usage_5h', value: 130 },
				]),
			},
			{
				data: openRouterSuccess(1700, 2000),
			},
		)

		const result = await poller.main()

		// Top-level shape
		expect(result).toHaveProperty('timestamp')
		expect(typeof result.timestamp).toBe('string')
		expect(result).toHaveProperty('threshold_pct', 80)
		expect(result).toHaveProperty('any_exceeded', true)
		expect(result).toHaveProperty('errors')
		expect(Array.isArray(result.errors)).toBe(true)

		// Each quota entry has PostHog-required fields
		for (const [, quota] of Object.entries(result.quotas)) {
			expect(quota).toHaveProperty('used')
			expect(typeof quota.used).toBe('number')
			expect(quota).toHaveProperty('limit')
			expect(typeof quota.limit).toBe('number')
			expect(quota).toHaveProperty('headroom_pct')
			expect(quota.headroom_pct === null || typeof quota.headroom_pct === 'number').toBe(true)
			expect(quota).toHaveProperty('exceeded')
			expect(typeof quota.exceeded).toBe('boolean')
		}

		// Verify all three routes present
		expect(Object.keys(result.quotas)).toHaveLength(3)
	})

	/* ------------------------------------------------------------------ */
	/*  Network error handling                                             */
	/* ------------------------------------------------------------------ */

	it('handles network failure for Anthropic', async () => {
		mockFetch(null, { data: openRouterSuccess(500, 2000) })

		const result = await poller.main()

		expect(result.quotas.claude_weekly).toBeUndefined()
		expect(result.quotas.claude_5h_overage).toBeUndefined()
		expect(result.quotas.openrouter_daily).toBeDefined()

		const error = result.errors.find((e) => e.route === 'claude')
		expect(error).toBeDefined()
		expect(error?.code).toBe('ANTHROPIC_FETCH_FAILED')
	})

	it('handles network failure for OpenRouter', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: 500 },
					{ metric: 'total_usage_5h', value: 30 },
				]),
			},
			null,
		)

		const result = await poller.main()

		expect(result.quotas.claude_weekly).toBeDefined()
		expect(result.quotas.openrouter_daily).toBeUndefined()

		const error = result.errors.find((e) => e.route === 'openrouter')
		expect(error).toBeDefined()
		expect(error?.code).toBe('OPENROUTER_FETCH_FAILED')
	})

	/* ------------------------------------------------------------------ */
	/*  Edge cases                                                         */
	/* ------------------------------------------------------------------ */

	it('edge: zero limit produces null headroom_pct and does not crash', async () => {
		mockFetch(
			{
				data: anthropicResponse([{ metric: 'total_usage_7d', value: 100 }]),
			},
			{ data: openRouterSuccess(0, 0) },
		)

		const result = await poller.main()

		// OpenRouter with 0 limit — a route without a ceiling can't compute headroom, so
		// headroom_pct is null and exceeded stays false (null routes don't taint any_exceeded).
		expect(result.quotas.openrouter_daily).toBeDefined()
		expect(result.quotas.openrouter_daily.headroom_pct).toBeNull()
		expect(result.quotas.openrouter_daily.exceeded).toBe(false)
	})

	it('edge: negative usage values are handled gracefully', async () => {
		mockFetch(
			{
				data: anthropicResponse([
					{ metric: 'total_usage_7d', value: -100 },
					{ metric: 'total_usage_5h', value: -10 },
				]),
			},
			{ data: openRouterSuccess(500, 2000) },
		)

		const result = await poller.main()

		expect(result.quotas.claude_weekly.headroom_pct).toBe(-10)
		expect(result.quotas.claude_weekly.exceeded).toBe(false)
	})
})

/* ------------------------------------------------------------------------ */
/*  Missing API keys — must produce structured errors for all 3 quotas     */
/*  and cause the CLI entry to exit 1. Runs in a separate describe with    */
/*  vi.resetModules() so the poller re-reads the (cleared) env at import.  */
/* ------------------------------------------------------------------------ */

describe('quota poller — missing API keys', () => {
	const originalAnthropic = process.env.ANTHROPIC_ADMIN_API_KEY
	const originalOpenRouter = process.env.OPENROUTER_API_KEY

	beforeEach(() => {
		vi.stubGlobal('console', {
			log: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	afterAll(() => {
		if (originalAnthropic === undefined) {
			Reflect.deleteProperty(process.env, 'ANTHROPIC_ADMIN_API_KEY')
		} else {
			process.env.ANTHROPIC_ADMIN_API_KEY = originalAnthropic
		}
		if (originalOpenRouter === undefined) {
			Reflect.deleteProperty(process.env, 'OPENROUTER_API_KEY')
		} else {
			process.env.OPENROUTER_API_KEY = originalOpenRouter
		}
	})

	async function loadPollerWith(env: Record<string, string | undefined>) {
		vi.resetModules()
		for (const [k, v] of Object.entries(env)) {
			if (v === undefined) Reflect.deleteProperty(process.env, k)
			else process.env[k] = v
		}
		return (await import('../poller')) as typeof import('../poller')
	}

	it('both keys missing: errors for claude_weekly, claude_5h_overage, openrouter_daily; no fetch calls', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const poller = await loadPollerWith({
			ANTHROPIC_ADMIN_API_KEY: '',
			OPENROUTER_API_KEY: '',
		})
		const result = await poller.main()

		expect(fetchMock).not.toHaveBeenCalled()
		expect(Object.keys(result.quotas)).toHaveLength(0)
		expect(result.any_exceeded).toBe(false)

		const routes = result.errors.map((e) => e.route).sort()
		expect(routes).toEqual(['claude_5h_overage', 'claude_weekly', 'openrouter_daily'])
		for (const e of result.errors) {
			expect(e.code).toBe('MISSING_API_KEY')
			expect(e.message).toMatch(/environment variable is not set/)
		}
	})

	it('only Anthropic key missing: errors for both claude quotas; OpenRouter is fetched', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				if (url.includes('openrouter.ai')) {
					return Promise.resolve(jsonResponse(openRouterSuccess(100, 1000)))
				}
				return Promise.resolve(jsonResponse({}, 404))
			}),
		)

		const poller = await loadPollerWith({
			ANTHROPIC_ADMIN_API_KEY: undefined,
			OPENROUTER_API_KEY: 'sk-or-test',
		})
		const result = await poller.main()

		const routes = result.errors.map((e) => e.route).sort()
		expect(routes).toEqual(['claude_5h_overage', 'claude_weekly'])
		expect(result.errors.every((e) => e.code === 'MISSING_API_KEY')).toBe(true)
		expect(result.quotas.openrouter_daily).toBeDefined()
	})

	it('only OpenRouter key missing: error for openrouter_daily; Anthropic is fetched', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				if (url.includes('api.anthropic.com')) {
					return Promise.resolve(
						jsonResponse(
							anthropicResponse([
								{ metric: 'total_usage_7d', value: 100 },
								{ metric: 'total_usage_5h', value: 10 },
							]),
						),
					)
				}
				return Promise.resolve(jsonResponse({}, 404))
			}),
		)

		const poller = await loadPollerWith({
			ANTHROPIC_ADMIN_API_KEY: 'sk-ant-test',
			OPENROUTER_API_KEY: undefined,
		})
		const result = await poller.main()

		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].route).toBe('openrouter_daily')
		expect(result.errors[0].code).toBe('MISSING_API_KEY')
		expect(result.quotas.claude_weekly).toBeDefined()
		expect(result.quotas.claude_5h_overage).toBeDefined()
	})

	it('whitespace-only key values are treated as missing', async () => {
		vi.stubGlobal('fetch', vi.fn())

		const poller = await loadPollerWith({
			ANTHROPIC_ADMIN_API_KEY: '   ',
			OPENROUTER_API_KEY: '\t',
		})
		const result = await poller.main()

		expect(result.errors.map((e) => e.code)).toEqual([
			'MISSING_API_KEY',
			'MISSING_API_KEY',
			'MISSING_API_KEY',
		])
	})
})
