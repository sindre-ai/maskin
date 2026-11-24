import type { ProviderConfig } from '../../types'

export const UNICONTA_PROVIDER = 'uniconta'

/**
 * Uniconta, through its hosted MCP server (https://mcp.uniconta.com/mcp, beta, launched 9 Nov
 * 2026). It is its own OAuth 2.1 authorization server: the owner signs in with their own
 * Uniconta login and the agent gets that user's permissions. Sign-in details are from its
 * published metadata at /.well-known/oauth-authorization-server (checked 22 Nov 2026, issuer
 * https://mcp.uniconta.com): open registration, authorization code with refresh token, PKCE S256,
 * public clients only (token auth method none, no secret).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/uniconta/callback` on
 * each public origin) through Uniconta's open registration (RFC 7591, public clients only), with
 * scripts/register-oauth-client.mjs --auth-method none; its id lives in UNICONTA_CLIENT_ID.
 *
 * Uniconta publishes no scopes, so none are asked for. Access is the signed-in user's own rights
 * and the server's list of companies.
 *
 * Read only in practice. The server's tools that change data (create_customer,
 * create_quick_invoice, invoice_order) answer only a client that speaks MCP revision 2026-07-28
 * and shows a form for the user's approval. The gateway does not pass that exchange through, so
 * through the gateway an agent reads and nothing is written. Tools carry no curated read list:
 * they are classified from the server's own annotations and names, and an unknown tool is a
 * write. Uniconta's own terms add that actions through the server count as the customer's own.
 */
export const config: ProviderConfig = {
	name: UNICONTA_PROVIDER,
	displayName: 'Uniconta',
	description:
		'Read Uniconta accounts, customers, orders and ledger entries. Beta server: each owner signs in with their own Uniconta login and accepts Uniconta’s MCP terms.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.uniconta.com/authorize',
			tokenUrl: 'https://mcp.uniconta.com/token',
			revokeUrl: 'https://mcp.uniconta.com/revoke',
			scopes: [],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'UNICONTA_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.uniconta.com/mcp'],
		envKey: 'UNICONTA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.uniconta.com/mcp',
			headers: { Authorization: 'Bearer ${UNICONTA_TOKEN}' },
		},
	},
}
