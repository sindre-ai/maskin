import type { ProviderConfig } from '../../types'

/**
 * Sentry, through its hosted MCP server (https://mcp.sentry.dev/mcp). Like Miro's and
 * Notion's, it is its own OAuth 2.1 authorization server, so the authorize and token URLs
 * below are the MCP host's, from its published metadata at
 * /.well-known/oauth-authorization-server (checked 9 Nov 2026, issuer https://mcp.sentry.dev).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/sentry/callback`
 * on each public origin) through Sentry's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in SENTRY_CLIENT_ID and
 * SENTRY_CLIENT_SECRET.
 *
 * Sentry publishes five scopes, all asked for up front because a token never gains a scope
 * later. Its `:write` scopes include the matching read, so these cover reading and editing
 * issues, events, projects, teams and alerts. A read-only agent stays read-only at the MCP
 * gateway (GATEWAY_PROVIDERS), not through a narrower sign-in. Its revocation endpoint is the
 * token URL itself, which the handler's revoke call does not fit, so none is set. Tools carry
 * no curated read list: they are classified from the server's own annotations and names, and
 * an unknown tool is a write.
 *
 * This is separate from the Sentry tool server some workspaces already run on a pasted key;
 * that one is a custom tool server and is not touched here.
 */
export const config: ProviderConfig = {
	name: 'sentry',
	displayName: 'Sentry',
	description: 'Read and triage Sentry issues, events and alerts through the Sentry MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.sentry.dev/oauth/authorize',
			tokenUrl: 'https://mcp.sentry.dev/oauth/token',
			scopes: ['org:read', 'project:write', 'team:write', 'event:write', 'alerts:write'],
			pkce: true,
			clientIdEnv: 'SENTRY_CLIENT_ID',
			clientSecretEnv: 'SENTRY_CLIENT_SECRET',
		},
	},

	// No webhook or events block: issues are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.sentry.dev/mcp'],
		envKey: 'SENTRY_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.sentry.dev/mcp',
			headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
		},
	},
}
