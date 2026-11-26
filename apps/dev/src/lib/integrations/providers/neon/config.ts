import type { ProviderConfig } from '../../types'

/**
 * Neon, through its hosted MCP server (https://mcp.neon.tech/mcp). Neon is its own authorization server:
 * the URLs below are from its published details at /.well-known/oauth-authorization-server (checked
 * 20 Nov 2026, issuer https://mcp.neon.tech).
 *
 * Neon accepts a public client, so only NEON_CLIENT_ID is set, registered once for Maskin's callback
 * (`/api/integrations/neon/callback` on each public origin) through its open registration (RFC 7591,
 * scripts/register-oauth-client.mjs --auth-method none).
 *
 * Neon publishes two scopes, `read` and `write`. We ask for `read` only; adding `write` later means
 * each person signs in again.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'neon',
	displayName: 'Neon',
	description: 'Read Neon projects, branches and databases through the Neon MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.neon.tech/api/authorize',
			tokenUrl: 'https://mcp.neon.tech/api/token',
			revokeUrl: 'https://mcp.neon.tech/api/revoke',
			scopes: ['read'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'NEON_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.neon.tech/mcp'],
		envKey: 'NEON_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.neon.tech/mcp',
			headers: { Authorization: 'Bearer ${NEON_TOKEN}' },
		},
	},
}
