import type { ProviderConfig } from '../../types'

/**
 * Notion, through its hosted MCP server (https://mcp.notion.com/mcp). Like Miro's, it is its
 * own OAuth 2.1 authorization server (not Notion's REST API app), so the authorize and token
 * URLs below are the MCP host's, from its published metadata at
 * /.well-known/oauth-authorization-server (checked 9 Nov 2026, issuer https://mcp.notion.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/notion/callback`
 * on each public origin) through Notion's open registration (RFC 7591, scripts/register-oauth-client.mjs);
 * its id and secret live in NOTION_CLIENT_ID and NOTION_CLIENT_SECRET.
 *
 * Notion publishes one scope, `default`, which covers read and write: a read-only agent stays
 * read-only at the MCP gateway (GATEWAY_PROVIDERS), not through a narrower sign-in. Its
 * revocation endpoint is the token URL itself, which the handler's revoke call does not fit,
 * so none is set. Tools carry no curated read list: they are classified from the server's own
 * annotations and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'notion',
	displayName: 'Notion',
	description: 'Read and edit Notion pages and databases through the Notion MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.notion.com/authorize',
			tokenUrl: 'https://mcp.notion.com/token',
			scopes: ['default'],
			pkce: true,
			clientIdEnv: 'NOTION_CLIENT_ID',
			clientSecretEnv: 'NOTION_CLIENT_SECRET',
		},
	},

	// No webhook or events block: pages are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
		envKey: 'NOTION_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.notion.com/mcp',
			headers: { Authorization: 'Bearer ${NOTION_TOKEN}' },
		},
	},
}
