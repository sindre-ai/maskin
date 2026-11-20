import type { ProviderConfig } from '../../types'

/**
 * Gusto, through its hosted MCP server (https://mcp.api.gusto.com). The authorize and token URLs below are
 * from the sign-in details the server publishes at mcp.api.gusto.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/gusto/callback` on each
 * public origin) through Gusto's open registration (RFC 7591, scripts/register-oauth-client.mjs gusto https://mcp.api.gusto.com/.well-known/oauth-authorization-server); its id and secret live in GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET.
 *
 * Only read scopes are asked for. Bank accounts, tax data, sensitive reports and everything that writes or runs payroll are left out; adding one later means every connected workspace signs in again.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'gusto',
	displayName: 'Gusto',
	description: 'Read Gusto employees, payrolls and time off through the Gusto MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.api.gusto.com/oauth/authorize',
			tokenUrl: 'https://mcp.api.gusto.com/oauth/token',
			scopes: [
				'public',
				'companies:read',
				'employees:read',
				'contractors:read',
				'departments:read',
				'employments:read',
				'jobs:read',
				'pay_schedules:read',
				'payrolls:read',
				'compensations:read',
				'employee_benefits:read',
				'time_off_policies:read',
				'time_off_requests:read',
				'time_sheet:read',
			],
			pkce: true,
			clientIdEnv: 'GUSTO_CLIENT_ID',
			clientSecretEnv: 'GUSTO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.api.gusto.com'],
		envKey: 'GUSTO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.api.gusto.com',
			headers: { Authorization: 'Bearer ${GUSTO_TOKEN}' },
		},
	},
}
