import type { ProviderConfig } from '../../types'

/**
 * Hex, through its hosted MCP server (https://app.hex.tech/mcp). The server's protected-resource metadata
 * names https://auth.app.hex.tech as its authorization server, and the URLs below are from that
 * server's published details at /.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * Hex accepts a public client, so only HEX_CLIENT_ID is set, registered once for Maskin's callback
 * (`/api/integrations/hex/callback` on each public origin) through its open registration (RFC 7591,
 * scripts/register-oauth-client.mjs --auth-method none).
 *
 * The authorization server lists four scopes (openid, profile, email, offline_access) and the tool
 * server lists none, so what the tools may do is decided by the person's own Hex role. We ask for the
 * four. Not yet tried against a live sign-in.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'hex',
	displayName: 'Hex',
	description: 'Read Hex projects and data through the Hex MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://auth.app.hex.tech/oauth2/authorize',
			tokenUrl: 'https://auth.app.hex.tech/oauth2/token',
			revokeUrl: 'https://auth.app.hex.tech/oauth2/revoke',
			scopes: ['openid', 'profile', 'email', 'offline_access'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'HEX_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://app.hex.tech/mcp'],
		envKey: 'HEX_TOKEN',
		server: {
			type: 'http',
			url: 'https://app.hex.tech/mcp',
			headers: { Authorization: 'Bearer ${HEX_TOKEN}' },
		},
	},
}
