import type { ProviderConfig } from '../../types'

/**
 * Mercury, through its hosted MCP server (https://mcp.mercury.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.mercury.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/mercury/callback` on each
 * public origin) through Mercury's open registration (RFC 7591, scripts/register-oauth-client.mjs mercury https://mcp.mercury.com/.well-known/oauth-authorization-server); its id and secret live in MERCURY_CLIENT_ID and MERCURY_CLIENT_SECRET (register with --auth-method client_secret_basic, which is the method this file sends).
 *
 * Mercury is a bank, so only the read scope and the refresh token are asked for. Its write scopes (transfers, categories, ledgers and more) are left out; adding one later means every connected workspace signs in again. Mercury's server is in beta.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'mercury',
	displayName: 'Mercury',
	description: 'Read Mercury accounts and transactions through the Mercury MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.mercury.com/authorize',
			tokenUrl: 'https://mcp.mercury.com/token',
			scopes: ['read', 'offline_access'],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'MERCURY_CLIENT_ID',
			clientSecretEnv: 'MERCURY_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.mercury.com/mcp'],
		envKey: 'MERCURY_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.mercury.com/mcp',
			headers: { Authorization: 'Bearer ${MERCURY_TOKEN}' },
		},
	},
}
