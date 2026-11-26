import type { ProviderConfig } from '../../types'

/**
 * PlanetScale, through its hosted MCP server (https://mcp.pscale.dev/mcp/planetscale). The server's
 * protected-resource metadata names https://api.planetscale.com as its authorization server, and the
 * URLs below are from that server's published details at /.well-known/oauth-authorization-server
 * (checked 20 Nov 2026). Authorize is on app.planetscale.com, token and registration on
 * auth.planetscale.com.
 *
 * The client is registered once for Maskin's callback (`/api/integrations/planetscale/callback` on
 * each public origin) through PlanetScale's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in PLANETSCALE_CLIENT_ID and
 * PLANETSCALE_CLIENT_SECRET. PlanetScale offers only clients with a secret.
 *
 * PlanetScale publishes over a hundred scopes. We ask for `read_organizations` and `read_databases`,
 * which should cover listing organizations, databases and branches. Which scopes each tool needs is
 * not published, so this may need widening on the first real sign-in.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'planetscale',
	displayName: 'PlanetScale',
	description: 'Read PlanetScale databases and branches through the PlanetScale MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.planetscale.com/oauth/authorize',
			tokenUrl: 'https://auth.planetscale.com/oauth/token',
			revokeUrl: 'https://auth.planetscale.com/oauth/revoke',
			scopes: ['read_organizations', 'read_databases'],
			pkce: true,
			clientIdEnv: 'PLANETSCALE_CLIENT_ID',
			clientSecretEnv: 'PLANETSCALE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.pscale.dev/mcp/planetscale'],
		envKey: 'PLANETSCALE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.pscale.dev/mcp/planetscale',
			headers: { Authorization: 'Bearer ${PLANETSCALE_TOKEN}' },
		},
	},
}
