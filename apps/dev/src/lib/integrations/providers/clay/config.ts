import type { ProviderConfig } from '../../types'

/**
 * Clay, through its hosted MCP server (https://api.clay.com/v3/mcp). Its sign-in details are
 * from its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov 2026,
 * issuer https://api.clay.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/clay/callback` on
 * each public origin) through Clay's open registration (RFC 7591, client_secret_post,
 * client_secret_basic or none), with scripts/register-oauth-client.mjs; its id and secret live
 * in CLAY_CLIENT_ID and CLAY_CLIENT_SECRET.
 *
 * Clay publishes two scopes, mcp and public-endpoints:mcp. Only mcp is asked for; the second is
 * for Clay's own public-endpoint feature and is not part of the MCP sign-in as far as the
 * published details show. Clay's docs say no Clay-side approval is needed, but a workspace
 * admin can block unknown clients. Not tried against a live sign-in.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'clay',
	displayName: 'Clay',
	description: 'Search and read Clay data and enrichment results through the Clay MCP.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.clay.com/oauth/authorize',
			tokenUrl: 'https://api.clay.com/oauth/token',
			revokeUrl: 'https://api.clay.com/oauth/revoke',
			scopes: ['mcp'],
			pkce: true,
			clientIdEnv: 'CLAY_CLIENT_ID',
			clientSecretEnv: 'CLAY_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.clay.com/v3/mcp'],
		envKey: 'CLAY_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.clay.com/v3/mcp',
			headers: { Authorization: 'Bearer ${CLAY_TOKEN}' },
		},
	},
}
