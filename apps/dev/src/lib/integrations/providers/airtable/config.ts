import type { ProviderConfig } from '../../types'

/**
 * Airtable, through its hosted MCP server (https://mcp.airtable.com/mcp). Like Miro's and
 * Notion's, the MCP host is its own OAuth 2.1 authorization server, here Airtable's at
 * https://airtable.com/oauth2/v1. The URLs below are from its published metadata at
 * https://mcp.airtable.com/.well-known/oauth-authorization-server (checked 9 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/airtable/callback`
 * on each public origin) through Airtable's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in AIRTABLE_CLIENT_ID and
 * AIRTABLE_CLIENT_SECRET.
 *
 * Airtable's token endpoint takes client_secret_basic or none, not client_secret_post, so the
 * secret goes in the Authorization header. It publishes S256 PKCE only. Scopes are read and write
 * for records, schema and comments, plus the list of bases; a read-only agent stays read-only at
 * the MCP gateway (GATEWAY_PROVIDERS), not through a narrower sign-in. No revocation endpoint is
 * published, so none is set. Tools carry no curated read list: they are classified from the
 * server's own annotations and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'airtable',
	displayName: 'Airtable',
	description: 'Read and edit Airtable bases, tables and records through the Airtable MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://airtable.com/oauth2/v1/authorize',
			tokenUrl: 'https://airtable.com/oauth2/v1/token',
			scopes: [
				'data.records:read',
				'data.records:write',
				'schema.bases:read',
				'schema.bases:write',
				'data.recordComments:read',
				'data.recordComments:write',
				'workspacesAndBases:read',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'AIRTABLE_CLIENT_ID',
			clientSecretEnv: 'AIRTABLE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: bases are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.airtable.com/mcp'],
		envKey: 'AIRTABLE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.airtable.com/mcp',
			headers: { Authorization: 'Bearer ${AIRTABLE_TOKEN}' },
		},
	},
}
