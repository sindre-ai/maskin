import type { ProviderConfig } from '../../types'

/**
 * Cloudflare, through its hosted MCP server (https://mcp.cloudflare.com/mcp). Cloudflare is its own
 * authorization server: the URLs below are from its published details at
 * /.well-known/oauth-authorization-server (checked 20 Nov 2026, issuer https://mcp.cloudflare.com).
 *
 * Cloudflare publishes hundreds of fine-grained scopes. We ask for the two its 401 challenge names,
 * `user:read` and `account:read`, which cover listing accounts and reading account details. Reading
 * a zone or its analytics may need more scopes; that is untested until a real sign-in. Its
 * revocation endpoint is the token URL itself, which the handler's revoke call does not fit, so none
 * is set.
 *
 * Cloudflare accepts a public client, so only CLOUDFLARE_CLIENT_ID is set, registered once for
 * Maskin's callback (`/api/integrations/cloudflare/callback` on each public origin) through its open
 * registration (RFC 7591, scripts/register-oauth-client.mjs --auth-method none). A workspace that
 * already runs Cloudflare as a custom tool server is a separate entry and is not touched here.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'cloudflare',
	displayName: 'Cloudflare',
	description: 'Read Cloudflare accounts, zones and analytics through the Cloudflare MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.cloudflare.com/authorize',
			tokenUrl: 'https://mcp.cloudflare.com/token',
			scopes: ['user:read', 'account:read'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'CLOUDFLARE_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.cloudflare.com/mcp'],
		envKey: 'CLOUDFLARE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.cloudflare.com/mcp',
			headers: { Authorization: 'Bearer ${CLOUDFLARE_TOKEN}' },
		},
	},
}
