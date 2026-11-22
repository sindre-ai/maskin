import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { resolvePublicOrigin } from './integrations'

// Plain Hono, not OpenAPIHono: these are Client ID Metadata Documents, read by a provider's MCP
// sign-in (https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document),
// not Maskin API routes. Public, no database, CORS open without credentials. A document's address
// is its client id, so VERCEL_CLIENT_ID must equal `client_id` below on each origin. The Shopify
// document only describes Maskin as a public client (no secret, PKCE); it turns nothing on.
const app = new Hono()

app.use('/oauth/client-metadata/*', cors({ origin: '*' }))

app.get('/oauth/client-metadata/vercel.json', (c) => {
	const origin = resolvePublicOrigin(c.req.url, c.req.header())
	c.header('Cache-Control', 'public, max-age=3600')
	return c.json({
		client_id: `${origin}/oauth/client-metadata/vercel.json`,
		client_name: 'Maskin',
		client_uri: origin,
		redirect_uris: [`${origin}/api/integrations/vercel/callback`],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
	})
})

app.get('/oauth/client-metadata/shopify.json', (c) => {
	const origin = resolvePublicOrigin(c.req.url, c.req.header())
	c.header('Cache-Control', 'public, max-age=3600')
	return c.json({
		client_id: `${origin}/oauth/client-metadata/shopify.json`,
		client_name: 'Maskin',
		client_uri: origin,
		redirect_uris: [`${origin}/api/integrations/shopify/callback`],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
	})
})

export default app
