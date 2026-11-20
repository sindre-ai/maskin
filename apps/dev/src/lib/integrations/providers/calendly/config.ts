import type { ProviderConfig } from '../../types'

/**
 * Calendly, through its hosted MCP server (https://mcp.calendly.com). Its sign-in details are
 * from its published metadata at /.well-known/oauth-authorization-server (checked 20 Nov 2026,
 * issuer https://calendly.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/calendly/callback` on
 * each public origin) through Calendly's open registration (RFC 7591, public clients only),
 * with scripts/register-oauth-client.mjs; its id lives in CALENDLY_CLIENT_ID.
 *
 * Calendly publishes three scopes. Only the two read ones are asked for (scheduling and
 * notetaker); mcp:scheduling:write is left out, so booking and cancelling tools answer with a
 * missing-scope error. Calendly's sign-in server accepts only public clients (token auth method
 * none, PKCE, no secret), so only CALENDLY_CLIENT_ID is set (register with --auth-method none).
 * The issuer URL ends in a slash. It publishes no revocation endpoint, so none is set.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'calendly',
	displayName: 'Calendly',
	description: 'Read Calendly event types, scheduled events and meeting notes.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://calendly.com/oauth/authorize',
			tokenUrl: 'https://calendly.com/oauth/token',
			scopes: ['mcp:scheduling:read', 'mcp:notetaker:read'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'CALENDLY_CLIENT_ID',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.calendly.com'],
		envKey: 'CALENDLY_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.calendly.com',
			headers: { Authorization: 'Bearer ${CALENDLY_TOKEN}' },
		},
	},
}
