import { isMcpOAuthEnabled } from '@maskin/auth/mcp'
import type { Database } from '@maskin/db'
import { type Context, Hono } from 'hono'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { captureTokenRejected } from '../lib/oauth-server/analytics'
import { requestClientIp } from '../lib/oauth-server/client-ip'
import { createRateLimiter } from '../lib/oauth-server/rate-limit'
import { handleTokenRequest, parseTokenForm } from '../lib/oauth-server/token'
import smokeStub from './oauth-smoke-stub'

// POST /oauth/token: where Claude trades its one-time code for an access and a refresh token, and
// later trades the refresh token for a new pair (RFC 6749). Public: the code, its PKCE verifier and
// the refresh token are the credential, so no API key. Plain Hono, not OpenAPIHono, because the
// body is form-encoded and the errors are RFC 6749's, not Maskin's. With MASKIN_MCP_OAUTH_ENABLED
// off it answers 404. Every response, success or error, is marked not cacheable.
const app = new Hono<{ Variables: { db: Database } }>()

// THROWAWAY smoke-test stub (never merge): serves GET /oauth/authorize while no consent page exists.
app.route('/', smokeStub)

/** 30 tries a minute from one address: far more than Claude makes, far less than a guesser needs. */
const allowToken = createRateLimiter(30, 60_000)

function noStore(c: Context) {
	c.header('Cache-Control', 'no-store')
	c.header('Pragma', 'no-cache')
}

app.post('/oauth/token', async (c) => {
	noStore(c)
	if (!isMcpOAuthEnabled()) return c.json(createApiError('NOT_FOUND', 'Not found'), 404)

	if (!allowToken(requestClientIp(c))) {
		captureTokenRejected({ reason: 'rate_limited' })
		c.header('Retry-After', '60')
		return c.json(
			{
				error: 'temporarily_unavailable',
				error_description: 'Too many requests, try again shortly',
			},
			429,
		)
	}

	const contentType = c.req.header('Content-Type')?.toLowerCase() ?? ''
	const form = contentType.startsWith('application/x-www-form-urlencoded')
		? parseTokenForm(await c.req.text())
		: null
	if (!form) {
		captureTokenRejected({ reason: 'invalid_request' })
		return c.json(
			{
				error: 'invalid_request',
				error_description: 'Send a form-encoded body with each parameter once',
			},
			400,
		)
	}

	try {
		const result = await handleTokenRequest(c.get('db'), form)
		if (result.ok) return c.json(result.body, 200)
		return c.json({ error: result.error, error_description: result.description }, result.status)
	} catch (err) {
		logger.error('OAuth token endpoint failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json({ error: 'server_error', error_description: 'Something went wrong' }, 500)
	}
})

export default app
