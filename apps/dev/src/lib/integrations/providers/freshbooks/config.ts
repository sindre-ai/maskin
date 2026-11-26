import type { ProviderConfig } from '../../types'

/**
 * FreshBooks, through its hosted MCP server (https://mcp.freshbooks.com/v1). The authorize and token URLs below are
 * from the sign-in details the server publishes at auth.freshbooks.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/freshbooks/callback` on each
 * public origin) through FreshBooks's open registration (RFC 7591, scripts/register-oauth-client.mjs freshbooks https://auth.freshbooks.com/.well-known/oauth-authorization-server); its id and secret live in FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET.
 *
 * LOW CONFIDENCE: this is the read-only server FreshBooks built as its Claude connector, and whether other clients are accepted is not documented. Only the read scope and the refresh token are asked for; the four mcp write scopes are left out. Drop it if registration or sign-in is refused.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'freshbooks',
	displayName: 'FreshBooks',
	description: 'Read FreshBooks invoices, clients and reports through the FreshBooks MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://auth.freshbooks.com/service/auth/oauth/authorize',
			tokenUrl: 'https://auth.freshbooks.com/service/auth/oauth/token',
			scopes: ['mcp:all:read', 'offline_access'],
			pkce: true,
			clientIdEnv: 'FRESHBOOKS_CLIENT_ID',
			clientSecretEnv: 'FRESHBOOKS_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.freshbooks.com/v1'],
		envKey: 'FRESHBOOKS_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.freshbooks.com/v1',
			headers: { Authorization: 'Bearer ${FRESHBOOKS_TOKEN}' },
		},
	},
}
