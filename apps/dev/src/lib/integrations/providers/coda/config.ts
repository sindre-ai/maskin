import type { ProviderConfig } from '../../types'

/**
 * Coda, through its hosted MCP server (https://coda.io/apis/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at coda.io/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/coda/callback` on each
 * public origin) through Coda's open registration (RFC 7591, scripts/register-oauth-client.mjs coda https://coda.io/.well-known/oauth-authorization-server); its id and secret live in CODA_CLIENT_ID and CODA_CLIENT_SECRET.
 *
 * LOW CONFIDENCE: Coda's own pages returned 403 when this was researched, so "official" rests on its live metadata and a secondary article, and the address may have moved to docs.superhuman.com/apis/mcp. Drop it if registration or sign-in is refused.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'coda',
	displayName: 'Coda',
	description: 'Read and edit Coda docs and tables through the Coda MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://coda.io/v4/api/oauth2/authorize',
			tokenUrl: 'https://coda.io/v4/api/oauth2/token',
			scopes: ['mcp:all'],
			pkce: true,
			clientIdEnv: 'CODA_CLIENT_ID',
			clientSecretEnv: 'CODA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://coda.io/apis/mcp'],
		envKey: 'CODA_TOKEN',
		server: {
			type: 'http',
			url: 'https://coda.io/apis/mcp',
			headers: { Authorization: 'Bearer ${CODA_TOKEN}' },
		},
	},
}
