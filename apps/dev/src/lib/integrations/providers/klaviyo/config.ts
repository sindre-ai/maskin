import type { ProviderConfig } from '../../types'

/**
 * Klaviyo, through its hosted MCP server (https://mcp.klaviyo.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.klaviyo.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/klaviyo/callback` on each
 * public origin) through Klaviyo's open registration (RFC 7591, scripts/register-oauth-client.mjs klaviyo https://mcp.klaviyo.com/.well-known/oauth-authorization-server); its id and secret live in KLAVIYO_CLIENT_ID and KLAVIYO_CLIENT_SECRET.
 *
 * Klaviyo publishes no scope list, so none is asked for and the server decides what the sign-in covers.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'klaviyo',
	displayName: 'Klaviyo',
	description: 'Read Klaviyo profiles, lists, campaigns and metrics through the Klaviyo MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.klaviyo.com/authorize',
			tokenUrl: 'https://mcp.klaviyo.com/token',
			scopes: [],
			pkce: true,
			clientIdEnv: 'KLAVIYO_CLIENT_ID',
			clientSecretEnv: 'KLAVIYO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.klaviyo.com/mcp'],
		envKey: 'KLAVIYO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.klaviyo.com/mcp',
			headers: { Authorization: 'Bearer ${KLAVIYO_TOKEN}' },
		},
	},
}
