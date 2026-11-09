import type { ProviderConfig } from '../../types'

/**
 * Intercom (US workspaces), through its hosted MCP server (https://mcp.intercom.com/mcp). Like
 * Miro's and Notion's, it is its own OAuth 2.1 authorization server, so the authorize and token
 * URLs below are the MCP host's, from its published metadata at
 * /.well-known/oauth-authorization-server (checked 9 Nov 2026, issuer https://mcp.intercom.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/intercom/callback`
 * on each public origin) through Intercom's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in INTERCOM_CLIENT_ID and
 * INTERCOM_CLIENT_SECRET.
 *
 * Intercom publishes two scopes, `mcp` and `operator`. `mcp` is the tool-server scope and covers
 * read and write: a read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not
 * through a narrower sign-in. `operator` is not asked for. The revocation endpoint is the token
 * URL itself, which the handler's revoke call does not fit, so none is set. Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 *
 * US only. The EU workspace server (mcp.eu.intercom.com) is a later add.
 */
export const config: ProviderConfig = {
	name: 'intercom',
	displayName: 'Intercom',
	description:
		'Read and update Intercom conversations, contacts and articles through the Intercom MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.intercom.com/authorize',
			tokenUrl: 'https://mcp.intercom.com/token',
			scopes: ['mcp'],
			pkce: true,
			clientIdEnv: 'INTERCOM_CLIENT_ID',
			clientSecretEnv: 'INTERCOM_CLIENT_SECRET',
		},
	},

	// No webhook or events block: Intercom is read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.intercom.com/mcp'],
		envKey: 'INTERCOM_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.intercom.com/mcp',
			headers: { Authorization: 'Bearer ${INTERCOM_TOKEN}' },
		},
	},
}
