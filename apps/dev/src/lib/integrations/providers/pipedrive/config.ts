import type { ProviderConfig } from '../../types'

/**
 * Pipedrive, through its hosted MCP server (https://mcp.pipedrive.ai/mcp). Its sign-in details are
 * from its published metadata (checked 22 Nov 2026, issuer https://oauth.pipedrive.com): code flow
 * with PKCE S256, client_secret_basic, client_secret_post or none.
 *
 * Pipedrive advertises open registration, but its staff allow-list clients and redirect addresses in
 * practice (forum threads, 10 to 19 Nov 2026; no official page describes it). Register Maskin with
 * scripts/register-oauth-client.mjs and ask Pipedrive to approve it. Until then PIPEDRIVE_CLIENT_ID
 * is unset and the tile stays hidden. Id and secret live in PIPEDRIVE_CLIENT_ID and
 * PIPEDRIVE_CLIENT_SECRET; the redirect address is `/api/integrations/pipedrive/callback`.
 *
 * Pipedrive's `:full` scopes include writing and it has no read-only version of them, so writes are
 * held back by the per-agent read-only setting. Mail, mail sending, projects and admin scopes are
 * not asked for. Revocation needs the client id and secret as a basic header, so token auth is
 * client_secret_basic.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'pipedrive',
	displayName: 'Pipedrive',
	description:
		'Search and read Pipedrive deals, people, organisations and activities. Pipedrive must approve Maskin first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://oauth.pipedrive.com/oauth/authorize',
			tokenUrl: 'https://oauth.pipedrive.com/oauth/token',
			revokeUrl: 'https://oauth.pipedrive.com/oauth/revoke',
			scopes: [
				'base',
				'search:read',
				'users:read',
				'activities:full',
				'contact-fields:full',
				'contacts:full',
				'deal-fields:full',
				'deals:full',
				'leads:full',
				'product-fields:full',
				'products:full',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'PIPEDRIVE_CLIENT_ID',
			clientSecretEnv: 'PIPEDRIVE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.pipedrive.ai/mcp'],
		envKey: 'PIPEDRIVE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.pipedrive.ai/mcp',
			headers: { Authorization: 'Bearer ${PIPEDRIVE_TOKEN}' },
		},
	},
}
