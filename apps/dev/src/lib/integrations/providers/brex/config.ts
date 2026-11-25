import type { ProviderConfig } from '../../types'

/**
 * Brex, through its hosted MCP server (https://api.brex.com/mcp). The authorize and token URLs below are
 * from the sign-in details the server publishes at api.brex.com/.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/brex/callback` on each
 * public origin) through Brex's open registration (RFC 7591, scripts/register-oauth-client.mjs brex https://api.brex.com/.well-known/oauth-authorization-server); its id and secret live in BREX_CLIENT_ID and BREX_CLIENT_SECRET.
 *
 * Brex publishes ?prompt=consent on its authorize address; it is sent as an extra parameter instead. Only the read scopes are asked for. The write scopes (cards, expenses, accounting records, fields) are left out; adding one later means every connected workspace signs in again. A customer admin accepts Brex's Developer API agreement before the first sign-in.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'brex',
	displayName: 'Brex',
	description: 'Read Brex cards, expenses, budgets and accounts through the Brex MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts-api.brex.com/oauth2/default/v1/authorize',
			tokenUrl: 'https://accounts-api.brex.com/oauth2/default/v1/token',
			scopes: [
				'openid',
				'offline_access',
				'email',
				'users.readonly',
				'departments.readonly',
				'locations.readonly',
				'titles.readonly',
				'legal_entities.readonly',
				'cards.readonly',
				'companies.readonly',
				'budgets.readonly',
				'travel.trips.readonly',
				'expenses.card.readonly',
				'audit_logs.readonly',
				'accounts.cash.readonly',
				'vendors.readonly',
				'tasks.readonly',
				'billing_groups.readonly',
				'accounting.integration.read',
				'accounting.record.read',
				'fields.read',
				'field_values.read',
			],
			pkce: true,
			extraAuthParams: { prompt: 'consent' },
			clientIdEnv: 'BREX_CLIENT_ID',
			clientSecretEnv: 'BREX_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.brex.com/mcp'],
		envKey: 'BREX_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.brex.com/mcp',
			headers: { Authorization: 'Bearer ${BREX_TOKEN}' },
		},
	},
}
