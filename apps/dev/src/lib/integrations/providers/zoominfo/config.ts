import type { ProviderConfig } from '../../types'

/**
 * ZoomInfo, through its hosted MCP server (https://mcp.zoominfo.com/mcp). Its sign-in details
 * are from its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov
 * 2026, issuer https://mcp.zoominfo.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/zoominfo/callback` on
 * each public origin) through ZoomInfo's open registration (RFC 7591, client_secret_basic or
 * client_secret_post), with scripts/register-oauth-client.mjs; its id and secret live in
 * ZOOMINFO_CLIENT_ID and ZOOMINFO_CLIENT_SECRET.
 *
 * The server publishes seven scopes and all are asked for: the three identity ones,
 * offline_access so the token can be refreshed, and the three ZoomInfo ones the MCP needs. The
 * sign-in page is on the MCP host, the token and revocation addresses on ZoomInfo's own Okta
 * host. Whether a given customer's plan includes MCP access is ZoomInfo's side and not checked
 * here.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'zoominfo',
	displayName: 'ZoomInfo',
	description:
		'Search ZoomInfo contacts and companies and read their details. Needs a ZoomInfo subscription that includes the MCP.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.zoominfo.com/oauth/authorize',
			tokenUrl: 'https://okta-login.zoominfo.com/oauth2/default/v1/token',
			revokeUrl: 'https://okta-login.zoominfo.com/oauth2/default/v1/revoke',
			scopes: ['openid', 'profile', 'email', 'offline_access', 'zi_api', 'zi_mcp', 'api:data:mcp'],
			pkce: true,
			clientIdEnv: 'ZOOMINFO_CLIENT_ID',
			clientSecretEnv: 'ZOOMINFO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.zoominfo.com/mcp'],
		envKey: 'ZOOMINFO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.zoominfo.com/mcp',
			headers: { Authorization: 'Bearer ${ZOOMINFO_TOKEN}' },
		},
	},
}
