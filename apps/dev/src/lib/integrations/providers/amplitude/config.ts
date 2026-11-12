import type { ProviderConfig } from '../../types'

/**
 * Amplitude, through its hosted MCP server (https://mcp.amplitude.com/mcp, the US server; the EU
 * server is separate and not listed). Like Notion's, it is its own OAuth 2.1 authorization
 * server, so the authorize and token URLs below are the MCP host's, from its published metadata at
 * /.well-known/oauth-authorization-server (checked 10 Nov 2026, issuer https://mcp.amplitude.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/amplitude/callback` on
 * each public origin) through Amplitude's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id lives in AMPLITUDE_CLIENT_ID. Amplitude's token
 * endpoint offers client_secret_post or none, but its registration issues a public client
 * (token_endpoint_auth_method none, no secret) even when post is asked for, so the client uses
 * PKCE with no secret and only AMPLITUDE_CLIENT_ID is set. PKCE is S256 only.
 *
 * Scopes are the three Amplitude publishes: all:read, all:write and offline_access (for a refresh
 * token). A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not through a
 * narrower sign-in. Its revocation endpoint takes client_secret_post only and is not wired, so none
 * is set. Tools carry no curated read list: they are classified from the server's own annotations
 * and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'amplitude',
	displayName: 'Amplitude',
	description: 'Read and edit Amplitude charts, dashboards and cohorts through the Amplitude MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.amplitude.com/authorize',
			tokenUrl: 'https://mcp.amplitude.com/token',
			scopes: ['all:read', 'all:write', 'offline_access'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'AMPLITUDE_CLIENT_ID',
		},
	},

	// No webhook or events block: charts and dashboards are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.amplitude.com/mcp'],
		envKey: 'AMPLITUDE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.amplitude.com/mcp',
			headers: { Authorization: 'Bearer ${AMPLITUDE_TOKEN}' },
		},
	},
}
