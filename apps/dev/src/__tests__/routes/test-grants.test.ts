import testGrantsRoutes, { isTestGrantEnabled } from '../../routes/test-grants'
import { buildWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const TOKEN = 'test-grant-token-value'

/**
 * The seam that lets E2E reach states the product deliberately makes
 * non-self-service. Its whole security value is "absent unless configured",
 * so that is what these assert.
 */
describe('POST /api/test-grants/:id', () => {
	const ORIGINAL = process.env.MASKIN_TEST_GRANT_TOKEN

	afterEach(() => {
		// `delete`, not `= undefined`: assigning undefined to process.env
		// stores the STRING "undefined", which would leave the var truthy and
		// make the "token unset" case below pass for the wrong reason.
		// biome-ignore lint/performance/noDelete: required for correct env semantics
		if (ORIGINAL === undefined) delete process.env.MASKIN_TEST_GRANT_TOKEN
		else process.env.MASKIN_TEST_GRANT_TOKEN = ORIGINAL
	})

	function grant(token?: string) {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		if (token !== undefined) headers['X-Test-Grant-Token'] = token
		return headers
	}

	describe('isTestGrantEnabled', () => {
		it('is false when the token is unset or empty, true only when set', () => {
			expect(isTestGrantEnabled({} as NodeJS.ProcessEnv)).toBe(false)
			expect(isTestGrantEnabled({ MASKIN_TEST_GRANT_TOKEN: '' } as NodeJS.ProcessEnv)).toBe(false)
			expect(isTestGrantEnabled({ MASKIN_TEST_GRANT_TOKEN: 'x' } as NodeJS.ProcessEnv)).toBe(true)
		})
	})

	it('returns 403 and writes nothing when no token header is sent', async () => {
		process.env.MASKIN_TEST_GRANT_TOKEN = TOKEN
		const ws = buildWorkspace()
		const { app, mockResults, calls } = createTestApp(testGrantsRoutes, '/api/test-grants')
		mockResults.select = [ws]

		const res = await app.request(
			jsonRequest('POST', `/api/test-grants/${ws.id}`, { plan: 'team' }),
		)

		expect(res.status).toBe(403)
		expect(calls.updates).toHaveLength(0)
	})

	it('returns 403 and writes nothing when the token is wrong', async () => {
		process.env.MASKIN_TEST_GRANT_TOKEN = TOKEN
		const ws = buildWorkspace()
		const { app, mockResults, calls } = createTestApp(testGrantsRoutes, '/api/test-grants')
		mockResults.select = [ws]

		const res = await app.request(
			new Request(`http://localhost/api/test-grants/${ws.id}`, {
				method: 'POST',
				headers: grant('wrong-token-same-length'),
				body: JSON.stringify({ plan: 'team' }),
			}),
		)

		expect(res.status).toBe(403)
		expect(calls.updates).toHaveLength(0)
	})

	// The route is normally unmounted without a token, but a stack that somehow
	// reached the handler with the token cleared must still refuse.
	it('returns 403 when the server token is unset, even with a header present', async () => {
		// biome-ignore lint/performance/noDelete: must be genuinely absent, not "undefined"
		delete process.env.MASKIN_TEST_GRANT_TOKEN
		const ws = buildWorkspace()
		const { app, mockResults, calls } = createTestApp(testGrantsRoutes, '/api/test-grants')
		mockResults.select = [ws]

		const res = await app.request(
			new Request(`http://localhost/api/test-grants/${ws.id}`, {
				method: 'POST',
				headers: grant(TOKEN),
				body: JSON.stringify({ plan: 'team' }),
			}),
		)

		expect(res.status).toBe(403)
		expect(calls.updates).toHaveLength(0)
	})

	it('grants a plan tier with a valid token, preserving unrelated settings keys', async () => {
		process.env.MASKIN_TEST_GRANT_TOKEN = TOKEN
		const ws = buildWorkspace()
		ws.settings = {
			...ws.settings,
			custom_extensions: { demo: 'keep-me' },
			billing: { plan: 'trial' },
		} as typeof ws.settings
		const { app, mockResults, calls } = createTestApp(testGrantsRoutes, '/api/test-grants')
		mockResults.select = [ws]
		mockResults.update = [ws]

		const res = await app.request(
			new Request(`http://localhost/api/test-grants/${ws.id}`, {
				method: 'POST',
				headers: grant(TOKEN),
				body: JSON.stringify({ plan: 'team' }),
			}),
		)

		expect(res.status).toBe(200)
		const written = calls.updates[0] as { settings: Record<string, unknown> }
		expect(written.settings.billing).toEqual({ plan: 'team', status: 'active' })
		// The raw row is spread, so a sibling key survives the grant.
		expect(written.settings.custom_extensions).toEqual({ demo: 'keep-me' })
	})

	it('grants byollm_allowed with a valid token', async () => {
		process.env.MASKIN_TEST_GRANT_TOKEN = TOKEN
		const ws = buildWorkspace()
		const { app, mockResults, calls } = createTestApp(testGrantsRoutes, '/api/test-grants')
		mockResults.select = [ws]
		mockResults.update = [ws]

		const res = await app.request(
			new Request(`http://localhost/api/test-grants/${ws.id}`, {
				method: 'POST',
				headers: grant(TOKEN),
				body: JSON.stringify({ byollm_allowed: true }),
			}),
		)

		expect(res.status).toBe(200)
		expect((calls.updates[0] as { byollmAllowed: boolean }).byollmAllowed).toBe(true)
	})

	it('returns 404 for an unknown workspace', async () => {
		process.env.MASKIN_TEST_GRANT_TOKEN = TOKEN
		const { app, mockResults } = createTestApp(testGrantsRoutes, '/api/test-grants')
		mockResults.select = []

		const res = await app.request(
			new Request('http://localhost/api/test-grants/00000000-0000-0000-0000-000000000099', {
				method: 'POST',
				headers: grant(TOKEN),
				body: JSON.stringify({ plan: 'team' }),
			}),
		)

		expect(res.status).toBe(404)
	})
})
