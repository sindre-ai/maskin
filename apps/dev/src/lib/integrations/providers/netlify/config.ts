import type { ProviderConfig } from '../../types'

/**
 * Netlify, through its hosted MCP server (https://mcp.netlify.com/mcp). Netlify is its own authorization
 * server: the URLs below are from its published details at /.well-known/oauth-authorization-server
 * (checked 20 Nov 2026, issuer https://mcp.netlify.com/).
 *
 * Netlify accepts a public client, so only NETLIFY_CLIENT_ID is set, registered once for Maskin's
 * callback (`/api/integrations/netlify/callback` on each public origin) through its open
 * registration (RFC 7591, scripts/register-oauth-client.mjs --auth-method none).
 *
 * Netlify publishes four scopes: `read`, `write`, `offline_access` and `claudeai`. We ask for `read`
 * and `offline_access` (so the token can be refreshed). `claudeai` is for Claude's own client.
 * Netlify publishes no revocation endpoint, so none is set.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'netlify',
	displayName: 'Netlify',
	description: 'Read Netlify sites and deploys through the Netlify MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.netlify.com/oauth-server/auth',
			tokenUrl: 'https://mcp.netlify.com/oauth-server/token',
			scopes: ['read', 'offline_access'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'NETLIFY_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.netlify.com/mcp'],
		envKey: 'NETLIFY_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.netlify.com/mcp',
			headers: { Authorization: 'Bearer ${NETLIFY_TOKEN}' },
		},
	},
}
