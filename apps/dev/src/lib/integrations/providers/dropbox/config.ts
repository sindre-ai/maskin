import type { ProviderConfig } from '../../types'

/**
 * Dropbox, through its hosted MCP server (https://mcp.dropbox.com/mcp, beta). Its sign-in details
 * are from its published metadata (checked 22 Nov 2026, issuer https://www.dropbox.com): code flow
 * with PKCE S256, client_secret_post, basic or none.
 *
 * Dropbox's open registration works only for an allow-listed set of clients (ChatGPT, Claude,
 * Cursor, Codex); other clients ask Dropbox Support (help.dropbox.com/integrations/connect-dropbox-mcp-server).
 * Until that is granted DROPBOX_CLIENT_ID is unset and the tile stays hidden. The client id and
 * secret live in DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET; the redirect address is
 * `/api/integrations/dropbox/callback`.
 *
 * Only the read scopes are asked for (account, file metadata and content, sharing, file requests).
 * `token_access_type=offline` is what makes Dropbox hand out a refresh token. There is no
 * revocation address here: Dropbox revokes with the access token as a bearer header, not a form
 * field, which the shared revoke call does not send.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'dropbox',
	displayName: 'Dropbox',
	description:
		'Search and read Dropbox files and folders. Dropbox must approve Maskin as an MCP client first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://www.dropbox.com/oauth2/authorize',
			tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
			scopes: [
				'account_info.read',
				'files.metadata.read',
				'files.content.read',
				'sharing.read',
				'file_requests.read',
			],
			pkce: true,
			extraAuthParams: { token_access_type: 'offline' },
			clientIdEnv: 'DROPBOX_CLIENT_ID',
			clientSecretEnv: 'DROPBOX_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.dropbox.com/mcp'],
		envKey: 'DROPBOX_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.dropbox.com/mcp',
			headers: { Authorization: 'Bearer ${DROPBOX_TOKEN}' },
		},
	},
}
