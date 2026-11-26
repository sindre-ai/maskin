import type { ProviderConfig } from '../../types'

/**
 * Gong, through its hosted MCP server (https://mcp.gong.io/mcp). Its sign-in details are from
 * its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov 2026,
 * issuer https://mcp.gong.io).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/gong/callback` on
 * each public origin) through Gong's open registration (RFC 7591, client_secret_basic or
 * client_secret_post), with scripts/register-oauth-client.mjs; its id and secret live in
 * GONG_CLIENT_ID and GONG_CLIENT_SECRET.
 *
 * Gong publishes two scopes, mcp:read and mcp:write. Only mcp:read is asked for, so write tools
 * answer with a missing-scope error. Sign-in and token addresses are on app.gong.io, not the
 * MCP host. A customer admin has to approve the connection in Gong before a person can sign in;
 * the tile text says so. It publishes no revocation endpoint, so none is set.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'gong',
	displayName: 'Gong',
	description:
		'Search Gong calls and read transcripts and summaries. A Gong admin must approve the connection first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.gong.io/oauth2/authorize',
			tokenUrl: 'https://app.gong.io/oauth2/generate-mcp-token',
			scopes: ['mcp:read'],
			pkce: true,
			clientIdEnv: 'GONG_CLIENT_ID',
			clientSecretEnv: 'GONG_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.gong.io/mcp'],
		envKey: 'GONG_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.gong.io/mcp',
			headers: { Authorization: 'Bearer ${GONG_TOKEN}' },
		},
	},
}
