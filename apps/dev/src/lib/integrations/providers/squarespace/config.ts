import type { ProviderConfig } from '../../types'

/**
 * Squarespace, through its hosted MCP server (https://mcp.squarespace.com/mcp). Its sign-in details
 * are from its published metadata (checked 22 Nov 2026, issuer https://login.squarespace.com): code
 * flow with PKCE S256, client_secret_basic or none, one scope `mcp`, client metadata documents but
 * no registration endpoint.
 *
 * Squarespace's commerce tools are limited to Claude and ChatGPT, and how another client gets in is
 * not documented (developers.squarespace.com/mcp/tools/commerce). So Maskin must ask Squarespace for
 * access first; until then SQUARESPACE_CLIENT_ID is unset and the tile stays hidden. Id and secret
 * live in SQUARESPACE_CLIENT_ID and SQUARESPACE_CLIENT_SECRET; the redirect address is
 * `/api/integrations/squarespace/callback`.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'squarespace',
	displayName: 'Squarespace',
	description:
		'Read Squarespace site and commerce data. Squarespace must approve Maskin as an MCP client first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.squarespace.com/api/1/login/oauth/provider/authorize',
			tokenUrl: 'https://login.squarespace.com/api/1/login/oauth/provider/tokens',
			scopes: ['mcp'],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'SQUARESPACE_CLIENT_ID',
			clientSecretEnv: 'SQUARESPACE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.squarespace.com/mcp'],
		envKey: 'SQUARESPACE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.squarespace.com/mcp',
			headers: { Authorization: 'Bearer ${SQUARESPACE_TOKEN}' },
		},
	},
}
