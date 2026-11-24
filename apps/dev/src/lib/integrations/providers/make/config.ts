import type { ProviderConfig } from '../../types'

/**
 * Make, through its hosted MCP server (https://mcp.make.com/v2). Its sign-in details are from
 * its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov 2026,
 * issuer https://www.make.com/mcp-openai).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/make/callback` on
 * each public origin) through Make's open registration (RFC 7591, client_secret_post), with
 * scripts/register-oauth-client.mjs; its id and secret live in MAKE_CLIENT_ID and
 * MAKE_CLIENT_SECRET.
 *
 * Make publishes no scope list. The person picks the organization and the scopes on Make's own
 * consent screen, so none is asked for here. Make's sign-in server is named mcp-openai in its
 * metadata, and its registration address ends in /register/mcp-openai; whether it accepts a
 * client that is not OpenAI's is unproven until the register script is run, and is the
 * likeliest of the eight to be refused. Make's "Run your scenarios" scope lets an agent run
 * every on-demand and active scenario in the organization.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'make',
	displayName: 'Make',
	description:
		'Work with Make scenarios through the Make MCP. You pick the organization and scopes when you sign in.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://www.make.com/oauth/v2/authorize',
			tokenUrl: 'https://www.make.com/oauth/v2/token',
			revokeUrl: 'https://www.make.com/oauth/v2/revoke',
			scopes: [],
			pkce: true,
			clientIdEnv: 'MAKE_CLIENT_ID',
			clientSecretEnv: 'MAKE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.make.com/v2'],
		envKey: 'MAKE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.make.com/v2',
			headers: { Authorization: 'Bearer ${MAKE_TOKEN}' },
		},
	},
}
