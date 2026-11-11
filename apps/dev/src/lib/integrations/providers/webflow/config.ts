import type { ProviderConfig } from '../../types'

/**
 * Webflow, through its hosted MCP server (https://mcp.webflow.com/mcp). Like Notion's, it is its
 * own OAuth 2.1 authorization server, so the authorize and token URLs below are the MCP host's,
 * from its published metadata at /.well-known/oauth-authorization-server (checked 10 Nov 2026,
 * issuer https://mcp.webflow.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/webflow/callback` on
 * each public origin) through Webflow's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in WEBFLOW_CLIENT_ID and
 * WEBFLOW_CLIENT_SECRET. Its token endpoint offers client_secret_basic, client_secret_post and
 * none; the default (post) is used. It publishes S256 and plain PKCE; Maskin sends S256.
 *
 * Webflow publishes no scopes, in either metadata document, so none are sent and the sign-in
 * grants whatever the person approves on Webflow's page. Webflow can publish sites, so a read-only
 * agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Its revocation endpoint is the
 * token URL itself, which the handler's revoke call does not fit, so none is set. Tools carry no
 * curated read list: they are classified from the server's own annotations and names, and an
 * unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'webflow',
	displayName: 'Webflow',
	description: 'Read and edit Webflow sites and CMS content through the Webflow MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.webflow.com/oauth/authorize',
			tokenUrl: 'https://mcp.webflow.com/oauth/token',
			scopes: [],
			pkce: true,
			clientIdEnv: 'WEBFLOW_CLIENT_ID',
			clientSecretEnv: 'WEBFLOW_CLIENT_SECRET',
		},
	},

	// No webhook or events block: sites and CMS content are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.webflow.com/mcp'],
		envKey: 'WEBFLOW_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.webflow.com/mcp',
			headers: { Authorization: 'Bearer ${WEBFLOW_TOKEN}' },
		},
	},
}
