import type { ProviderConfig } from '../../types'

/**
 * Miro, through its hosted MCP server (https://mcp.miro.com/). Miro's MCP is its own
 * OAuth 2.1 authorization server (it is not Miro's REST API app), so the authorize and
 * token URLs below are the MCP host's, from its published metadata at
 * /.well-known/oauth-authorization-server. It offers no revocation endpoint.
 *
 * The client is registered once for Maskin's callback (`/api/integrations/miro/callback`
 * on each public origin) through Miro's open registration (RFC 7591); its id and secret
 * live in MIRO_CLIENT_ID and MIRO_CLIENT_SECRET.
 *
 * Read and write scopes are both requested up front, because a token never gains a scope
 * later. A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not
 * through a narrower sign-in. Miro's tools carry no curated read list here: they are
 * classified from the server's own annotations and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'miro',
	displayName: 'Miro',
	description: 'Read and edit Miro boards through the Miro MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.miro.com/authorize',
			tokenUrl: 'https://mcp.miro.com/token',
			scopes: ['boards:read', 'boards:write'],
			pkce: true,
			clientIdEnv: 'MIRO_CLIENT_ID',
			clientSecretEnv: 'MIRO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: boards are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.miro.com/'],
		envKey: 'MIRO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.miro.com/',
			headers: { Authorization: 'Bearer ${MIRO_TOKEN}' },
		},
	},
}
