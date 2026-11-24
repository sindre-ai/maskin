import type { ProviderConfig } from '../../types'

/**
 * Mural, through its hosted MCP server (https://mcp-canvas.mural.co/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp-canvas.mural.co/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/mural/callback` on each
 * public origin) through Mural's open registration (RFC 7591, scripts/register-oauth-client.mjs mural https://mcp-canvas.mural.co/.well-known/oauth-authorization-server); its id and secret live in MURAL_CLIENT_ID and MURAL_CLIENT_SECRET.
 *
 * A customer admin can allowlist clients on their Mural workspace; a workspace that does must add Maskin before anyone there can connect.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'mural',
	displayName: 'Mural',
	description: 'Read and edit Mural boards and rooms through the Mural MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp-canvas.mural.co/authorize',
			tokenUrl: 'https://mcp-canvas.mural.co/token',
			scopes: ['murals:read', 'murals:write', 'rooms:read', 'workspaces:read'],
			pkce: true,
			clientIdEnv: 'MURAL_CLIENT_ID',
			clientSecretEnv: 'MURAL_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp-canvas.mural.co/mcp'],
		envKey: 'MURAL_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp-canvas.mural.co/mcp',
			headers: { Authorization: 'Bearer ${MURAL_TOKEN}' },
		},
	},
}
