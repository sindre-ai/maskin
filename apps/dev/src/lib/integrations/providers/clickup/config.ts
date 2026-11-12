import type { ProviderConfig } from '../../types'

/**
 * ClickUp, through its hosted MCP server (https://mcp.clickup.com/mcp). Like Notion's, it is its
 * own OAuth 2.1 authorization server, so the authorize and token URLs below are the MCP host's,
 * from its published metadata at /.well-known/oauth-authorization-server (checked 10 Nov 2026,
 * issuer https://mcp.clickup.com). ClickUp's docs say the MCP server takes OAuth only, no personal
 * API keys.
 *
 * ClickUp publishes one token auth method, `none`: a public client with PKCE and no secret. So only
 * CLICKUP_CLIENT_ID is set, registered once for Maskin's callback
 * (`/api/integrations/clickup/callback` on each public origin) through ClickUp's open registration
 * (RFC 7591, scripts/register-oauth-client.mjs). It publishes the scopes read and write, and the
 * authorization_code grant only: no refresh token is offered, so a sign-in lasts as long as ClickUp
 * lets the access token live.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not through a narrower
 * sign-in. No revocation endpoint is published, so none is set. Tools carry no curated read list:
 * they are classified from the server's own annotations and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'clickup',
	displayName: 'ClickUp',
	description: 'Read and edit ClickUp tasks, docs and chat through the ClickUp MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.clickup.com/oauth/authorize',
			tokenUrl: 'https://mcp.clickup.com/oauth/token',
			scopes: ['read', 'write'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'CLICKUP_CLIENT_ID',
		},
	},

	// No webhook or events block: tasks, docs and chat are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.clickup.com/mcp'],
		envKey: 'CLICKUP_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.clickup.com/mcp',
			headers: { Authorization: 'Bearer ${CLICKUP_TOKEN}' },
		},
	},
}
