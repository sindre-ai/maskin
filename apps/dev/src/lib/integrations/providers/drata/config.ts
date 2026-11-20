import type { ProviderConfig } from '../../types'

/**
 * Drata, through its hosted MCP server (https://mcp.drata.com/mcp/). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.drata.com/.well-known/oauth-authorization-server/mcp (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/drata/callback` on each
 * public origin) through Drata's open registration (RFC 7591, scripts/register-oauth-client.mjs drata https://mcp.drata.com/.well-known/oauth-authorization-server/mcp); its id and secret live in DRATA_CLIENT_ID and DRATA_CLIENT_SECRET.
 *
 * Only read scopes are asked for. The create, update and delete scopes are left out; adding one later means every connected workspace signs in again. The token and registration addresses are on Drata's Auth0 tenant, not on drata.com.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'drata',
	displayName: 'Drata',
	description: 'Read Drata controls, risks, policies and vendors through the Drata MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.drata.com/auth0-proxy/authorize',
			tokenUrl: 'https://drata-prod.us.auth0.com/oauth/token',
			scopes: [
				'openid',
				'profile',
				'email',
				'offline_access',
				'read:controls',
				'read:monitor-test',
				'read:monitor-test-failure',
				'read:monitor-test-pass',
				'read:compliance-check-exclusion',
				'read:monitor-test-exclusion',
				'read:policy',
				'read:assigned-policies',
				'read:risk',
				'read:risk-registers',
				'read:workspace',
				'read:company',
				'read:users',
				'read:user',
				'read:framework',
				'read:evidence',
				'read:vendor',
				'read:vendor-security-review',
				'read:vendor-document',
				'read:personnel',
				'read:device',
				'read:custom-task',
			],
			pkce: true,
			clientIdEnv: 'DRATA_CLIENT_ID',
			clientSecretEnv: 'DRATA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.drata.com/mcp/'],
		envKey: 'DRATA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.drata.com/mcp/',
			headers: { Authorization: 'Bearer ${DRATA_TOKEN}' },
		},
	},
}
