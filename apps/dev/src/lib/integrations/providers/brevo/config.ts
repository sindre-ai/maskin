import type { ProviderConfig } from '../../types'

/**
 * Brevo, through its hosted MCP server (https://mcp.brevo.com/v1/brevo/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.brevo.com/.well-known/oauth-authorization-server/oauth (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/brevo/callback` on each
 * public origin) through Brevo's open registration (RFC 7591, scripts/register-oauth-client.mjs brevo https://mcp.brevo.com/.well-known/oauth-authorization-server/oauth); a public client with PKCE and no secret, so only BREVO_CLIENT_ID is set (register with --auth-method none).
 *
 * LOW CONFIDENCE: Brevo's docs describe a bearer token while its live metadata advertises open registration. This follows the live metadata. Drop it if registration or sign-in is refused.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'brevo',
	displayName: 'Brevo',
	description: 'Read Brevo contacts, campaigns and email activity through the Brevo MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.brevo.com/oauth/authorize',
			tokenUrl: 'https://mcp.brevo.com/oauth/token',
			scopes: ['all'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'BREVO_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.brevo.com/v1/brevo/mcp'],
		envKey: 'BREVO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.brevo.com/v1/brevo/mcp',
			headers: { Authorization: 'Bearer ${BREVO_TOKEN}' },
		},
	},
}
