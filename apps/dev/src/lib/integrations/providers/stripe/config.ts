import type { ProviderConfig } from '../../types'

/**
 * Stripe, through its hosted MCP server (https://mcp.stripe.com). Sign-in is on a different
 * host from the tool server: the server's protected-resource metadata names
 * https://access.stripe.com/mcp as its authorization server, and the authorize and token URLs
 * below are from that server's published details at
 * https://access.stripe.com/.well-known/oauth-authorization-server/mcp (checked 9 Nov 2026,
 * issuer https://access.stripe.com/mcp).
 *
 * Stripe publishes one scope, `mcp`, and one token auth method, `none`: a public client with
 * PKCE and no secret. So only STRIPE_CLIENT_ID is set, registered once for Maskin's callback
 * (`/api/integrations/stripe/callback` on each public origin) through Stripe's open
 * registration (RFC 7591, scripts/register-oauth-client.mjs). Its revocation endpoint is
 * separate and public-client shaped; nothing calls revoke today, so none is set.
 *
 * Stripe can move money, and the single scope covers read and write, so a new connection
 * starts at Read only and a read-only agent stays read-only at the MCP gateway
 * (GATEWAY_PROVIDERS). Stripe's tools are classified from the curated list in tool-kinds.ts,
 * not from their names: the names are not read verbs (stripe_api_read) and the one write
 * tool (stripe_api_write) takes any POST, PATCH, PUT or DELETE, so a tool outside the list is
 * a write.
 */
export const config: ProviderConfig = {
	name: 'stripe',
	displayName: 'Stripe',
	description: 'Read Stripe payments, customers and billing through the Stripe MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://access.stripe.com/mcp/oauth2/authorize',
			tokenUrl: 'https://access.stripe.com/mcp/oauth2/token',
			scopes: ['mcp'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'STRIPE_CLIENT_ID',
		},
	},

	// No webhook or events block: Stripe is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.stripe.com'],
		envKey: 'STRIPE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.stripe.com',
			headers: { Authorization: 'Bearer ${STRIPE_TOKEN}' },
		},
	},
}
