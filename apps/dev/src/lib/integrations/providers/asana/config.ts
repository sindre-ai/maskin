import type { ProviderConfig } from '../../types'

/**
 * Asana, through its V2 hosted MCP server (https://mcp.asana.com/v2/mcp). Its sign-in details are
 * from its published metadata (checked 22 Nov 2026, issuer https://app.asana.com): code flow with
 * PKCE S256, client_secret_post or client_secret_basic, scope `default`, no registration endpoint
 * (Asana docs: "Dynamic client registration is not supported with Asana's V2 MCP Server").
 *
 * Needs one MCP app that Maskin owns, registered in the Asana developer console
 * (developers.asana.com/docs/integrating-with-asanas-mcp-server). Its client id and secret live in
 * ASANA_CLIENT_ID and ASANA_CLIENT_SECRET, and its redirect address is
 * `/api/integrations/asana/callback` on each public origin. Asana's MCP guide names no review step;
 * its general publish page says submission is needed beyond your own organisation, and whether that
 * applies to an MCP app is unverified.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'asana',
	displayName: 'Asana',
	description:
		'Read and search Asana tasks, projects and comments. Needs an MCP app that Maskin owns in Asana.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.asana.com/-/oauth_authorize',
			tokenUrl: 'https://app.asana.com/-/oauth_token',
			revokeUrl: 'https://app.asana.com/-/oauth_revoke',
			scopes: ['default'],
			pkce: true,
			clientIdEnv: 'ASANA_CLIENT_ID',
			clientSecretEnv: 'ASANA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.asana.com/v2/mcp'],
		envKey: 'ASANA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.asana.com/v2/mcp',
			headers: { Authorization: 'Bearer ${ASANA_TOKEN}' },
		},
	},
}
