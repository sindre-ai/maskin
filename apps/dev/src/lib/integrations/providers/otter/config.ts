import type { ProviderConfig } from '../../types'

/**
 * Otter, through its hosted MCP server (https://mcp.otter.ai/mcp). Sign-in is on a different host
 * from the tool server: the server's protected-resource metadata names https://otter.ai as its
 * authorization server, and the URLs below are from that server's published details at
 * /.well-known/oauth-authorization-server (checked 20 Nov 2026, issuer https://otter.ai).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/otter/callback` on each
 * public origin) through Otter's open registration (RFC 7591, scripts/register-oauth-client.mjs);
 * its id and secret live in OTTER_CLIENT_ID and OTTER_CLIENT_SECRET.
 *
 * Otter publishes two scopes, both read: profile:read and conversations:read.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'otter',
	displayName: 'Otter',
	description: 'Search Otter conversations and read transcripts',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://otter.ai/oauth2/authorize',
			tokenUrl: 'https://otter.ai/oauth/token',
			revokeUrl: 'https://otter.ai/oauth/revoke_token',
			scopes: ['profile:read', 'conversations:read'],
			pkce: true,
			clientIdEnv: 'OTTER_CLIENT_ID',
			clientSecretEnv: 'OTTER_CLIENT_SECRET',
		},
	},

	// No webhook or events block: conversations are searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.otter.ai/mcp'],
		envKey: 'OTTER_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.otter.ai/mcp',
			headers: { Authorization: 'Bearer ${OTTER_TOKEN}' },
		},
	},
}
