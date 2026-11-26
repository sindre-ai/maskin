import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { resolvePublicOrigin } from './integrations'

// Plain Hono, not OpenAPIHono: these are the Client ID Metadata Documents that Vercel's and Shopify's
// MCP sign-in read (https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document),
// not Maskin API routes. Public, no database, CORS open without credentials. Each address is the client
// id, so VERCEL_CLIENT_ID (and the Shopify equivalent) must equal `client_id` below on each origin.
// Public clients with PKCE and no secret; the documents only describe Maskin and turn nothing on.
const app = new Hono()

app.use('/oauth/client-metadata/*', cors({ origin: '*' }))

for (const provider of ['vercel', 'shopify']) {
	app.get(`/oauth/client-metadata/${provider}.json`, (c) => {
		const origin = resolvePublicOrigin(c.req.url, c.req.header())
		c.header('Cache-Control', 'public, max-age=3600')
		return c.json({
			client_id: `${origin}/oauth/client-metadata/${provider}.json`,
			client_name: 'Maskin',
			client_uri: origin,
			redirect_uris: [`${origin}/api/integrations/${provider}/callback`],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		})
	})
}

export default app
