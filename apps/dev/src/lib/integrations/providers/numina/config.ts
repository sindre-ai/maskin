import type { ProviderConfig } from '../../types'

/**
 * Numina (Danish accounting), through its own MCP server (https://api.numina.app/mcp). The
 * server is its own OAuth 2.1 authorization server, so the authorize and token URLs below are
 * from its published metadata at /.well-known/oauth-authorization-server (checked 22 Nov 2026,
 * issuer https://api.numina.app): authorization code and refresh token, PKCE S256, open
 * registration (RFC 7591). The owner signs in to Numina, picks the company and approves.
 *
 * The client is registered once for Maskin's callback (`/api/integrations/numina/callback`
 * on each public origin) with scripts/register-oauth-client.mjs; its id and secret live in
 * NUMINA_CLIENT_ID and NUMINA_CLIENT_SECRET.
 *
 * Two scopes, the ones the MCP resource itself lists: read:ledger (every read tool) and
 * write:draft (draft tools only). Numina's MCP cannot book: a draft waits in Numina for the
 * owner to approve it, so nothing here asks for the book scopes (journal:book, invoices:book).
 * offline_access asks for the refresh token (tokens last 1 hour, the refresh token 30 days).
 * Numina publishes a revocation endpoint, but the handler's revoke call has not been checked
 * against it, so none is set. A read-only agent stays read-only at the MCP gateway
 * (GATEWAY_PROVIDERS), not through a narrower sign-in. Tools carry no curated read list: they
 * are classified from the server's own annotations and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'numina',
	displayName: 'Numina',
	description: 'Read ledger data and save draft entries in Numina through the Numina MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.numina.app/oauth/authorize',
			tokenUrl: 'https://api.numina.app/auth/oauth2/token',
			scopes: ['read:ledger', 'write:draft', 'offline_access'],
			pkce: true,
			clientIdEnv: 'NUMINA_CLIENT_ID',
			clientSecretEnv: 'NUMINA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: the ledger is read and drafts are saved on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.numina.app/mcp'],
		envKey: 'NUMINA_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.numina.app/mcp',
			headers: { Authorization: 'Bearer ${NUMINA_TOKEN}' },
		},
	},
}
