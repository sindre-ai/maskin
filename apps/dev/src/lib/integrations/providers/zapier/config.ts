import type { ProviderConfig } from '../../types'

/**
 * Zapier, through its hosted MCP server (https://mcp.zapier.com/api/mcp/mcp). This is the shared
 * OAuth address, not the older per-person address that carries a personal key in its path: its
 * protected-resource metadata at /.well-known/oauth-protected-resource/api/mcp/mcp names
 * https://mcp.zapier.com as the authorization server, and the authorize and token URLs below are
 * from its published details at /.well-known/oauth-authorization-server (checked 10 Nov 2026,
 * issuer https://mcp.zapier.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/zapier/callback` on each
 * public origin) through Zapier's open registration (RFC 7591, scripts/register-oauth-client.mjs);
 * its id and secret live in ZAPIER_CLIENT_ID and ZAPIER_CLIENT_SECRET. Its token endpoint offers
 * client_secret_post, client_secret_basic and none; the default (post) is used. PKCE is S256 only.
 *
 * The only scopes Zapier publishes are openid, profile and email. What the agent can do is set by
 * the actions the person has turned on in Zapier, not by scope. Those actions change things in
 * other tools, so a read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), and a
 * tool is a write unless Zapier marks it read-only. Its revocation endpoint is not wired: nothing
 * calls revoke today, so none is set.
 */
export const config: ProviderConfig = {
	name: 'zapier',
	displayName: 'Zapier',
	description: 'Run the Zapier actions a person has allowed through the Zapier MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.zapier.com/oauth/authorize',
			tokenUrl: 'https://mcp.zapier.com/api/v1/oauth/token',
			scopes: ['openid', 'profile', 'email'],
			pkce: true,
			clientIdEnv: 'ZAPIER_CLIENT_ID',
			clientSecretEnv: 'ZAPIER_CLIENT_SECRET',
		},
	},

	// No webhook or events block: actions are run on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.zapier.com/api/mcp/mcp'],
		envKey: 'ZAPIER_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.zapier.com/api/mcp/mcp',
			headers: { Authorization: 'Bearer ${ZAPIER_TOKEN}' },
		},
	},
}
