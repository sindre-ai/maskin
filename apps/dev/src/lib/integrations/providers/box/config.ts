import type { ProviderConfig } from '../../types'

export const BOX_PROVIDER = 'box'

const MCP_URL = 'https://mcp.box.com'

/**
 * Box, through its hosted MCP server (https://mcp.box.com, protected-resource metadata read live
 * on 22 Nov 2026, naming https://api.box.com as its authorization server).
 *
 * Box has no dynamic client registration for it. Each customer's Box admin creates an unlisted
 * Box MCP server in the Admin Console, which hands out a Client ID and Client Secret under
 * Integration Credentials, and pastes them into Settings. That is customerApp: the workspace's own
 * app is read at sign-in and at refresh, and there is no Maskin-owned Box app. BOX_CLIENT_ID and
 * BOX_CLIENT_SECRET are an optional server-wide fallback and are normally unset.
 *
 * Sources: developer.box.com/guides/box-mcp/remote (server URL, scopes, credentials from the
 * Admin Console) and https://api.box.com/.well-known/oauth-authorization-server (authorize and
 * token URLs, S256 PKCE, client_secret_post and client_secret_basic, refresh_token grant).
 *
 * The docs name three scopes. We ask for the first two. docgen.readwrite needs an Enterprise
 * Advanced licence and would fail the sign-in for every other plan. Not yet tried against a live
 * Box sign-in.
 */
export const config: ProviderConfig = {
	name: BOX_PROVIDER,
	displayName: 'Box',
	description:
		'Search, read and manage files in Box. Your Box admin creates an MCP server in the Admin Console once and you paste its client ID and secret here.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://account.box.com/api/oauth2/authorize',
			tokenUrl: 'https://api.box.com/oauth2/token',
			revokeUrl: 'https://api.box.com/oauth2/revoke',
			scopes: ['root_readwrite', 'ai.readwrite'],
			pkce: true,
			tokenAuthMethod: 'client_secret_post',
			customerApp: true,
			clientIdEnv: 'BOX_CLIENT_ID',
			clientSecretEnv: 'BOX_CLIENT_SECRET',
		},
	},

	// No webhook or events block: files are read and changed on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', MCP_URL],
		envKey: 'BOX_TOKEN',
		server: {
			type: 'http',
			url: MCP_URL,
			headers: { Authorization: 'Bearer ${BOX_TOKEN}' },
		},
	},
}
