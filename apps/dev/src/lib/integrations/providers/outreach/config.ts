import type { ProviderConfig } from '../../types'

/**
 * Outreach, through its hosted MCP server (https://api.outreach.io/mcp). Its sign-in details
 * are from its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov
 * 2026, issuer https://api.outreach.io).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/outreach/callback` on
 * each public origin) through Outreach's open registration (RFC 7591, client_secret_post), with
 * scripts/register-oauth-client.mjs; its id and secret live in OUTREACH_CLIENT_ID and
 * OUTREACH_CLIENT_SECRET.
 *
 * Outreach publishes one scope, prospects.all, which covers read and write: a read-only agent
 * stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not through a narrower sign-in. The
 * customer needs the Amplify add-on and an admin who has turned the MCP on; the tile text says
 * so. It publishes no revocation endpoint, so none is set.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'outreach',
	displayName: 'Outreach',
	description:
		'Search and read Outreach prospects. Needs the Amplify add-on on the Outreach account, and an Outreach admin to switch MCP on.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.outreach.io/mcpOAuth/authorize',
			tokenUrl: 'https://api.outreach.io/mcpOAuth/token',
			scopes: ['prospects.all'],
			pkce: true,
			clientIdEnv: 'OUTREACH_CLIENT_ID',
			clientSecretEnv: 'OUTREACH_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.outreach.io/mcp'],
		envKey: 'OUTREACH_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.outreach.io/mcp',
			headers: { Authorization: 'Bearer ${OUTREACH_TOKEN}' },
		},
	},
}
