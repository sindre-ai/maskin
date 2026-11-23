import type { ProviderConfig } from '../../types'

/**
 * Intercom, through its hosted US MCP server (https://mcp.intercom.com/mcp). Its sign-in details are
 * from its published metadata (checked 22 Nov 2026, issuer https://mcp.intercom.com): code flow with
 * PKCE S256, scope `mcp` (a second scope, `operator`, is not asked for).
 *
 * Registration is open, but Intercom's docs (developers.intercom.com/docs/guides/mcp) say a
 * redirect address that is not localhost must be allow-listed by Intercom support, and a Developer
 * Hub app review does not add it. Register Maskin with scripts/register-oauth-client.mjs, then ask
 * Intercom support to allow `/api/integrations/intercom/callback` on each public origin. Until then
 * INTERCOM_CLIENT_ID is unset and the tile stays hidden. Id and secret live in INTERCOM_CLIENT_ID
 * and INTERCOM_CLIENT_SECRET.
 *
 * Only the US server is wired. Intercom's EU workspaces use https://mcp.eu.intercom.com/mcp, which
 * needs its own provider. There is no revocation address: the one in the metadata is the token
 * address itself.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'intercom',
	displayName: 'Intercom',
	description:
		'Search Intercom conversations, contacts and articles, US workspaces only. Intercom must allow the redirect address first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.intercom.com/authorize',
			tokenUrl: 'https://mcp.intercom.com/token',
			scopes: ['mcp'],
			pkce: true,
			clientIdEnv: 'INTERCOM_CLIENT_ID',
			clientSecretEnv: 'INTERCOM_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.intercom.com/mcp'],
		envKey: 'INTERCOM_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.intercom.com/mcp',
			headers: { Authorization: 'Bearer ${INTERCOM_TOKEN}' },
		},
	},
}
