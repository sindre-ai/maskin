import type { ProviderConfig } from '../../types'

/**
 * Framer, through its hosted MCP server (https://mcp.framer.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at api.framer.com/.well-known/oauth-authorization-server/auth/oauth (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/framer/callback` on each
 * public origin) through Framer's open registration (RFC 7591, scripts/register-oauth-client.mjs framer https://api.framer.com/.well-known/oauth-authorization-server/auth/oauth); a public client with PKCE and no secret, so only FRAMER_CLIENT_ID is set (register with --auth-method none).
 *
 * Framer offers public clients only, so no secret is set. Its sign-in server sits on api.framer.com, with the MCP on mcp.framer.com.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'framer',
	displayName: 'Framer',
	description: 'Read and edit Framer projects through the Framer MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.framer.com/auth/oauth/authorize',
			tokenUrl: 'https://api.framer.com/auth/oauth/token',
			scopes: ['mcp:project'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'FRAMER_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.framer.com/mcp'],
		envKey: 'FRAMER_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.framer.com/mcp',
			headers: { Authorization: 'Bearer ${FRAMER_TOKEN}' },
		},
	},
}
