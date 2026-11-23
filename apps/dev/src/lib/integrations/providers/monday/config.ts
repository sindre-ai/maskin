import type { ProviderConfig } from '../../types'

/**
 * monday.com, through its hosted MCP server (https://mcp.monday.com/mcp). Its sign-in details
 * are from its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov
 * 2026, issuer https://auth.monday.com/mcp).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/monday/callback` on
 * each public origin) through monday.com's open registration (RFC 7591, client_secret_post,
 * client_secret_basic or none; CIMD too), with scripts/register-oauth-client.mjs; its id and
 * secret live in MONDAY_CLIENT_ID and MONDAY_CLIENT_SECRET.
 *
 * monday.com publishes no scope list, so none is asked for and the token carries what the
 * signed-in user and the account admin allow. A monday.com account admin approves the
 * connection and its redirect addresses in their own account; the tile text says so. Its sign-
 * in server lives under /mcp on auth.monday.com, which is also its issuer.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'monday',
	displayName: 'monday.com',
	description:
		'Read monday.com boards, items and updates. A monday.com account admin must approve the connection.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://auth.monday.com/oauth2/authorize',
			tokenUrl: 'https://auth.monday.com/oauth_ms/oauth/token',
			revokeUrl: 'https://auth.monday.com/oauth_ms/oauth/revoke',
			scopes: [],
			pkce: true,
			clientIdEnv: 'MONDAY_CLIENT_ID',
			clientSecretEnv: 'MONDAY_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.monday.com/mcp'],
		envKey: 'MONDAY_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.monday.com/mcp',
			headers: { Authorization: 'Bearer ${MONDAY_TOKEN}' },
		},
	},
}
