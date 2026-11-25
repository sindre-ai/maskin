import type { ProviderConfig } from '../../types'

/**
 * Wix, through its hosted MCP server (https://mcp.wix.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.wix.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/wix/callback` on each
 * public origin) through Wix's open registration (RFC 7591, scripts/register-oauth-client.mjs wix https://mcp.wix.com/.well-known/oauth-authorization-server); its id and secret live in WIX_CLIENT_ID and WIX_CLIENT_SECRET.
 *
 * Wix publishes only offline_access (the refresh token); what the sign-in covers is chosen on Wix's own consent screen.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'wix',
	displayName: 'Wix',
	description: 'Read and edit Wix sites through the Wix MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.wix.com/authorize',
			tokenUrl: 'https://mcp.wix.com/token',
			scopes: ['offline_access'],
			pkce: true,
			clientIdEnv: 'WIX_CLIENT_ID',
			clientSecretEnv: 'WIX_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.wix.com/mcp'],
		envKey: 'WIX_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.wix.com/mcp',
			headers: { Authorization: 'Bearer ${WIX_TOKEN}' },
		},
	},
}
