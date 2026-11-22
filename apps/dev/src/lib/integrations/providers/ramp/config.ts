import type { ProviderConfig } from '../../types'

/**
 * Ramp, through its hosted MCP server (https://mcp.ramp.com/mcp). Its sign-in details are from its
 * published metadata (checked 22 Nov 2026, issuer https://mcp.ramp.com): code flow with PKCE S256
 * and public clients only (token auth method none), so there is no client secret.
 *
 * Ramp's docs (agents.ramp.com/docs/guides/connecting) say a custom client needs its exact redirect
 * address allow-listed by Ramp through a support request. Register Maskin with
 * scripts/register-oauth-client.mjs --auth-method none, then ask Ramp to allow
 * `/api/integrations/ramp/callback` on each public origin. Until then RAMP_CLIENT_ID is unset and
 * the tile stays hidden.
 *
 * Only read scopes are asked for. Card numbers (`cards:read_agentic`, `agent_account_numbers:read`),
 * bank accounts, audit logs, treasury, agent wallet and everything that ends in `:write` are not.
 * The authorization address keeps the `auth_level=auto` query Ramp publishes.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'ramp',
	displayName: 'Ramp',
	description:
		'Read Ramp transactions, bills, cards, reimbursements and budgets. Ramp must allow the redirect address first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.ramp.com/oauth/authorize?auth_level=auto',
			tokenUrl: 'https://api.ramp.com/developer/v1/token/pkce',
			revokeUrl: 'https://api.ramp.com/developer/v1/token/revoke',
			scopes: [
				'accounting:read',
				'approvals:read',
				'bills:read',
				'budgets:read',
				'business:read',
				'cards:read',
				'departments:read',
				'entities:read',
				'limits:read',
				'memos:read',
				'purchase_orders:read',
				'receipts:read',
				'reimbursements:read',
				'spend_requests:read',
				'statements:read',
				'transactions:read',
				'trips:read',
				'users:read',
				'vendors:read',
			],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'RAMP_CLIENT_ID',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.ramp.com/mcp'],
		envKey: 'RAMP_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.ramp.com/mcp',
			headers: { Authorization: 'Bearer ${RAMP_TOKEN}' },
		},
	},
}
