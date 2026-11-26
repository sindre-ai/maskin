import type { ProviderConfig } from '../../types'

/**
 * Granola, through its hosted MCP server (https://mcp.granola.ai/mcp). Sign-in is on a different
 * host from the tool server: the server's protected-resource metadata names
 * https://mcp-auth.granola.ai as its authorization server, and the URLs below are from that
 * server's published details at /.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/granola/callback` on
 * each public origin) through Granola's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in GRANOLA_CLIENT_ID and
 * GRANOLA_CLIENT_SECRET.
 *
 * The authorization server lists four scopes (openid, profile, email, offline_access) and the
 * tool server lists one, `mcp`, which the authorization server does not list. We ask for the four
 * the sign-in side lists, offline_access so the token can be refreshed. Not yet tried against a
 * live sign-in.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'granola',
	displayName: 'Granola',
	description: 'Search Granola meeting notes and read transcripts',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp-auth.granola.ai/oauth2/authorize',
			tokenUrl: 'https://mcp-auth.granola.ai/oauth2/token',
			revokeUrl: 'https://mcp-auth.granola.ai/oauth2/revoke',
			scopes: ['openid', 'profile', 'email', 'offline_access'],
			pkce: true,
			clientIdEnv: 'GRANOLA_CLIENT_ID',
			clientSecretEnv: 'GRANOLA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: meetings are searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.granola.ai/mcp'],
		envKey: 'GRANOLA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.granola.ai/mcp',
			headers: { Authorization: 'Bearer ${GRANOLA_TOKEN}' },
		},
	},
}
