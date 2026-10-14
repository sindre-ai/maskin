import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleTokenRequest } = vi.hoisted(() => ({ handleTokenRequest: vi.fn() }))
vi.mock('../../lib/oauth-server/token', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/oauth-server/token')>()
	return { ...actual, handleTokenRequest }
})

const { capturePosthogEvent } = vi.hoisted(() => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent }))

import oauthTokenRoutes from '../../routes/oauth-token'

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }
const SUCCESS = {
	ok: true,
	body: {
		access_token: 'mat_x',
		token_type: 'Bearer',
		expires_in: 3600,
		refresh_token: 'mrt_x',
		scope: 'mcp',
	},
}

function appFor() {
	const app = new Hono<{ Variables: { db: unknown } }>()
	app.use('*', async (c, next) => {
		c.set('db', {})
		await next()
	})
	app.route('/', oauthTokenRoutes)
	return app
}

/** `ip` stands in for the socket address the Node server would supply. */
function post(
	app: ReturnType<typeof appFor>,
	body: string,
	headers: Record<string, string> = FORM,
	ip?: string,
) {
	return app.request(
		'/oauth/token',
		{ method: 'POST', headers, body },
		ip ? { incoming: { socket: { remoteAddress: ip } } } : undefined,
	)
}

beforeEach(() => {
	vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
	handleTokenRequest.mockReset()
	capturePosthogEvent.mockClear()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('POST /oauth/token', () => {
	it('answers 404 when the env switch is off, still marked not cacheable', async () => {
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')

		const res = await post(appFor(), 'grant_type=refresh_token')

		expect(res.status).toBe(404)
		expect(res.headers.get('Cache-Control')).toBe('no-store')
		expect(res.headers.get('Pragma')).toBe('no-cache')
		expect(handleTokenRequest).not.toHaveBeenCalled()
	})

	it('returns the token body with no-store and no-cache on success', async () => {
		handleTokenRequest.mockResolvedValue(SUCCESS)

		const res = await post(appFor(), 'grant_type=refresh_token&refresh_token=x')

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(SUCCESS.body)
		expect(res.headers.get('Cache-Control')).toBe('no-store')
		expect(res.headers.get('Pragma')).toBe('no-cache')
		expect(handleTokenRequest).toHaveBeenCalledWith(
			{},
			{
				grant_type: 'refresh_token',
				refresh_token: 'x',
			},
		)
	})

	it('returns an RFC 6749 error with a fixed description and the same headers', async () => {
		handleTokenRequest.mockResolvedValue({
			ok: false,
			status: 400,
			error: 'invalid_grant',
			description: 'The code or refresh token is invalid, expired or already used',
		})

		const res = await post(appFor(), 'grant_type=authorization_code&code=secret-code')

		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({
			error: 'invalid_grant',
			error_description: 'The code or refresh token is invalid, expired or already used',
		})
		expect(res.headers.get('Cache-Control')).toBe('no-store')
		expect(res.headers.get('Pragma')).toBe('no-cache')
	})

	it('answers 400 invalid_request for a body that is not form-encoded', async () => {
		const res = await post(appFor(), '{"grant_type":"refresh_token"}', {
			'Content-Type': 'application/json',
		})

		expect(res.status).toBe(400)
		expect((await res.json()).error).toBe('invalid_request')
		expect(res.headers.get('Cache-Control')).toBe('no-store')
		expect(handleTokenRequest).not.toHaveBeenCalled()
	})

	it('answers 400 invalid_request when a parameter is sent twice', async () => {
		const res = await post(appFor(), 'grant_type=refresh_token&client_id=a&client_id=b')

		expect(res.status).toBe(400)
		expect((await res.json()).error).toBe('invalid_request')
	})

	it('answers 500 server_error without leaking the cause', async () => {
		handleTokenRequest.mockRejectedValue(new Error('connection to db-host-17 refused'))

		const res = await post(appFor(), 'grant_type=refresh_token&refresh_token=x')

		expect(res.status).toBe(500)
		const text = await res.text()
		expect(JSON.parse(text).error).toBe('server_error')
		expect(text).not.toContain('db-host-17')
		expect(res.headers.get('Cache-Control')).toBe('no-store')
	})

	it('answers 429 temporarily_unavailable with Retry-After after 30 calls from one address', async () => {
		handleTokenRequest.mockResolvedValue(SUCCESS)
		const app = appFor()
		const body = 'grant_type=refresh_token&refresh_token=x'
		for (let i = 0; i < 30; i++) {
			expect((await post(app, body, FORM, '203.0.113.50')).status).toBe(200)
		}

		const res = await post(app, body, FORM, '203.0.113.50')
		const otherAddress = await post(app, body, FORM, '203.0.113.51')

		expect(res.status).toBe(429)
		expect((await res.json()).error).toBe('temporarily_unavailable')
		expect(res.headers.get('Retry-After')).toBe('60')
		expect(res.headers.get('Pragma')).toBe('no-cache')
		expect(otherAddress.status).toBe(200)
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'mcp_oauth_token_rejected',
			'oauth-unresolved',
			{
				reason: 'rate_limited',
				$process_person_profile: false,
			},
		)
	})
})
