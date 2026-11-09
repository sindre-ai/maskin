import { isMcpOAuthEnabled } from '@maskin/auth/mcp'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { createApiError } from '../lib/errors'
import {
	buildAuthorizationServerDocument,
	buildProtectedResourceDocument,
} from '../lib/oauth-server/discovery'

// Plain Hono, not OpenAPIHono: these are RFC documents, not Maskin API routes. Public, no
// database, CORS open without credentials. With MASKIN_MCP_OAUTH_ENABLED off they answer 404
// (explicitly, because the SPA fallback would otherwise answer with index.html).
const app = new Hono()

app.use('/.well-known/*', cors({ origin: '*' }))

const CACHE_CONTROL = 'public, max-age=3600'

function serve(build: () => object) {
	return (c: Context) => {
		if (!isMcpOAuthEnabled()) return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
		c.header('Cache-Control', CACHE_CONTROL)
		return c.json(build())
	}
}

app.get('/.well-known/oauth-protected-resource', serve(buildProtectedResourceDocument))
app.get('/.well-known/oauth-protected-resource/mcp', serve(buildProtectedResourceDocument))
app.get('/.well-known/oauth-authorization-server', serve(buildAuthorizationServerDocument))

export default app
