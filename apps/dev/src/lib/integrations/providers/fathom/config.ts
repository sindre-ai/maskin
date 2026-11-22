import type { ProviderConfig } from '../../types'

/**
 * Fathom, through its hosted MCP server (https://api.fathom.ai/mcp). Fathom is its own
 * authorization server: the URLs below are from its published details at
 * /.well-known/oauth-authorization-server (checked 20 Nov 2026, issuer https://api.fathom.ai).
 * The sign-in page is on fathom.video, the token and registration addresses on fathom.ai.
 *
 * Fathom publishes one scope, `mcp`, and one token auth method, `none`: a public client with PKCE
 * and no secret. So only FATHOM_CLIENT_ID is set, registered once for Maskin's callback
 * (`/api/integrations/fathom/callback` on each public origin) through Fathom's open registration
 * (RFC 7591, scripts/register-oauth-client.mjs --auth-method none). It publishes no revocation
 * endpoint, so none is set.
 *
 * Fathom's separate public-API app programme (with a review) is for its REST API. Nothing in the
 * MCP's published details points to a review for the MCP sign-in; that is untested until a real
 * person signs in.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'fathom',
	displayName: 'Fathom',
	description: 'Search Fathom meetings and read transcripts and summaries',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://fathom.video/mcp/oauth/authorize',
			tokenUrl: 'https://api.fathom.ai/mcp/oauth/token',
			scopes: ['mcp'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'FATHOM_CLIENT_ID',
		},
	},

	// No webhook or events block: meetings are searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.fathom.ai/mcp'],
		envKey: 'FATHOM_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.fathom.ai/mcp',
			headers: { Authorization: 'Bearer ${FATHOM_TOKEN}' },
		},
	},
}
