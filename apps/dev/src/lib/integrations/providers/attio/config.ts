import type { ProviderConfig } from '../../types'

/**
 * Attio, through its hosted MCP server (https://mcp.attio.com/mcp). Like Miro's and Notion's,
 * it is its own OAuth 2.1 authorization server, but unlike them the sign-in lives on a
 * different host from the tool server: the issuer is https://mcp.attio.com while the authorize
 * and token URLs are on https://app.attio.com. Both come from its published metadata at
 * https://mcp.attio.com/.well-known/oauth-authorization-server (checked 9 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/attio/callback`
 * on each public origin) through Attio's open registration (RFC 7591,
 * https://app.attio.com/oauth/register, scripts/register-oauth-client.mjs); its id and
 * secret live in ATTIO_CLIENT_ID and ATTIO_CLIENT_SECRET.
 *
 * Attio publishes `mcp` as the one scope for the tool server (plus `openid` and
 * `offline_access`, which gives the refresh token); it covers read and write, so a read-only
 * agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not through a narrower
 * sign-in. `email` is not asked for. Attio also offers a revocation endpoint
 * (https://app.attio.com/oidc/revoke); none is set here because it has not been tried against
 * the handler's revoke call. Tools carry no curated read list: they are classified from the
 * server's own annotations and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'attio',
	displayName: 'Attio',
	description: 'Read and edit Attio CRM records through the Attio MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.attio.com/oidc/authorize',
			tokenUrl: 'https://app.attio.com/oidc/token',
			scopes: ['openid', 'offline_access', 'mcp'],
			pkce: true,
			clientIdEnv: 'ATTIO_CLIENT_ID',
			clientSecretEnv: 'ATTIO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: records are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.attio.com/mcp'],
		envKey: 'ATTIO_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.attio.com/mcp',
			headers: { Authorization: 'Bearer ${ATTIO_TOKEN}' },
		},
	},
}
