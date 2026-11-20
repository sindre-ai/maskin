import type { ProviderConfig } from '../../types'

/**
 * Trello, through its hosted MCP server (https://mcp.trello.com/v1). The authorize and token URLs below are
 * from the sign-in details the server publishes at auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3 (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/trello/callback` on each
 * public origin) through Trello's open registration (RFC 7591, scripts/register-oauth-client.mjs trello https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3); its id and secret live in TRELLO_CLIENT_ID and TRELLO_CLIENT_SECRET.
 *
 * Trello's server signs in through Atlassian's sign-in server, with its own registration path (the metadata address below), separate from the Atlassian entry. Board, workspace and member scopes are asked for with read and write; the inbox and planner scopes are left out.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'trello',
	displayName: 'Trello',
	description: 'Read and edit Trello boards and cards through the Trello MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://auth.atlassian.com/authorize',
			tokenUrl: 'https://auth.atlassian.com/oauth/token',
			scopes: [
				'offline_access',
				'read:me',
				'read:account',
				'read:board:trello',
				'write:board:trello',
				'read:organization:trello',
				'write:organization:trello',
				'read:member:trello',
			],
			pkce: true,
			clientIdEnv: 'TRELLO_CLIENT_ID',
			clientSecretEnv: 'TRELLO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.trello.com/v1'],
		envKey: 'TRELLO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.trello.com/v1',
			headers: { Authorization: 'Bearer ${TRELLO_TOKEN}' },
		},
	},
}
