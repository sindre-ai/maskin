import type { ProviderConfig } from '../../types'

/**
 * Fireflies, through its hosted MCP server (https://api.fireflies.ai/mcp). Fireflies is its own
 * authorization server; the URLs below are from its published details at
 * /.well-known/oauth-authorization-server (checked 20 Nov 2026, issuer https://api.fireflies.ai/).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/fireflies/callback` on
 * each public origin) through Fireflies' open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in FIREFLIES_CLIENT_ID and
 * FIREFLIES_CLIENT_SECRET.
 *
 * Fireflies publishes three scopes. `meetings.upload` is left out: sending audio to Fireflies is
 * not reading meetings. A workspace that already runs Fireflies as a custom tool server on a
 * pasted key is a separate entry and is not touched here.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'fireflies',
	displayName: 'Fireflies',
	description: 'Search Fireflies meetings and read transcripts and summaries',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.fireflies.ai/authorize',
			tokenUrl: 'https://api.fireflies.ai/token',
			revokeUrl: 'https://api.fireflies.ai/revoke',
			scopes: ['profile', 'email'],
			pkce: true,
			clientIdEnv: 'FIREFLIES_CLIENT_ID',
			clientSecretEnv: 'FIREFLIES_CLIENT_SECRET',
		},
	},

	// No webhook or events block: meetings are searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.fireflies.ai/mcp'],
		envKey: 'FIREFLIES_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.fireflies.ai/mcp',
			headers: { Authorization: 'Bearer ${FIREFLIES_TOKEN}' },
		},
	},
}
