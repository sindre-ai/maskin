import type { ProviderConfig } from '../../types'

/**
 * Deel, through its hosted MCP server (https://api.letsdeel.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at api.letsdeel.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/deel/callback` on each
 * public origin) through Deel's open registration (RFC 7591, scripts/register-oauth-client.mjs deel https://api.letsdeel.com/.well-known/oauth-authorization-server); a public client with PKCE and no secret, so only DEEL_CLIENT_ID is set (register with --auth-method none).
 *
 * Only read scopes are asked for, picked from the ~100 Deel publishes. Which of them the MCP needs is not documented, so this list is untested until a real sign-in works. Deel offers public clients only, so no secret is set.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'deel',
	displayName: 'Deel',
	description: 'Read Deel contracts, people and payments through the Deel MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.letsdeel.com/oauth/authorize',
			tokenUrl: 'https://api.letsdeel.com/oauth/tokens',
			scopes: [
				'organizations:read',
				'people:read',
				'contracts:read',
				'jobs:read',
				'groups:read',
				'legal-entity:read',
				'global-payroll:read',
				'payments:read',
				'accounting:read',
				'benefits:read',
				'time-off:read',
				'timesheets:read',
				'approvals:read',
				'tasks:read',
				'worker:read',
			],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'DEEL_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.letsdeel.com/mcp'],
		envKey: 'DEEL_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.letsdeel.com/mcp',
			headers: { Authorization: 'Bearer ${DEEL_TOKEN}' },
		},
	},
}
