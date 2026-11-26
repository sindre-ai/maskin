import type { ProviderConfig } from '../../types'

/**
 * Greenhouse, through its hosted MCP server (https://mcp.greenhouse.io/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at auth.greenhouse.io/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/greenhouse/callback` on each
 * public origin) through Greenhouse's open registration (RFC 7591, scripts/register-oauth-client.mjs greenhouse https://auth.greenhouse.io/.well-known/oauth-authorization-server); its id and secret live in GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET.
 *
 * The one scope is the MCP server's own (greenhouse:mcp_client, from its protected-resource details); the sign-in server lists only openid, profile and email, so this is untested until a real sign-in works. A Greenhouse Site Admin has to add the tool in their Dev Center before anyone in that workspace can connect.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'greenhouse',
	displayName: 'Greenhouse',
	description: 'Read Greenhouse jobs, candidates and applications through the Greenhouse MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://auth.greenhouse.io/authorize',
			tokenUrl: 'https://auth.greenhouse.io/token',
			scopes: ['greenhouse:mcp_client'],
			pkce: true,
			clientIdEnv: 'GREENHOUSE_CLIENT_ID',
			clientSecretEnv: 'GREENHOUSE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.greenhouse.io/mcp'],
		envKey: 'GREENHOUSE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.greenhouse.io/mcp',
			headers: { Authorization: 'Bearer ${GREENHOUSE_TOKEN}' },
		},
	},
}
