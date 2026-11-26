import type { ProviderConfig } from '../../types'

/**
 * Retool, through its hosted MCP server (https://mcp.retool.com/mcp). Retool is its own authorization
 * server: the URLs below are from its published details at /.well-known/oauth-authorization-server
 * (checked 20 Nov 2026, issuer https://mcp.retool.com).
 *
 * Retool offers only public clients, so only RETOOL_CLIENT_ID is set, registered once for Maskin's
 * callback (`/api/integrations/retool/callback` on each public origin) through its open registration
 * (RFC 7591, scripts/register-oauth-client.mjs --auth-method none).
 *
 * Retool publishes `mcp:read`, `mcp:write` and `mcp:admin`. We ask for `mcp:read` only; adding the
 * others later means each person signs in again.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'retool',
	displayName: 'Retool',
	description: 'Read Retool apps and resources through the Retool MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.retool.com/auth/oauth2/authorize',
			tokenUrl: 'https://mcp.retool.com/api/oauth2/token',
			revokeUrl: 'https://mcp.retool.com/api/oauth2/revoke',
			scopes: ['mcp:read'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'RETOOL_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.retool.com/mcp'],
		envKey: 'RETOOL_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.retool.com/mcp',
			headers: { Authorization: 'Bearer ${RETOOL_TOKEN}' },
		},
	},
}
