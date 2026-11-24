import type { ProviderConfig } from '../../types'

/**
 * Vanta, through its hosted MCP server (https://mcp.vanta.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.vanta.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/vanta/callback` on each
 * public origin) through Vanta's open registration (RFC 7591, scripts/register-oauth-client.mjs vanta https://mcp.vanta.com/.well-known/oauth-authorization-server); a public client with PKCE and no secret, so only VANTA_CLIENT_ID is set (register with --auth-method none).
 *
 * Vanta publishes one scope and it is named :write; it is the only one on offer, so a read-only agent stays read-only at the MCP gateway, not through the sign-in. Vanta also serves EU and AUS hosts; only the US host is set here.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'vanta',
	displayName: 'Vanta',
	description: 'Read Vanta tests, controls and compliance status through the Vanta MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.vanta.com/oauth/authorize',
			tokenUrl: 'https://api.vanta.com/oauth/token',
			scopes: ['mcp-api.all:write'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'VANTA_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.vanta.com/mcp'],
		envKey: 'VANTA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.vanta.com/mcp',
			headers: { Authorization: 'Bearer ${VANTA_TOKEN}' },
		},
	},
}
