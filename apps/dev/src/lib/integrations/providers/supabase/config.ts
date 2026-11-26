import type { ProviderConfig } from '../../types'

/**
 * Supabase, through its hosted MCP server (https://mcp.supabase.com/mcp). The server's protected-resource
 * metadata names https://api.supabase.com as its authorization server, and the URLs below are from
 * that server's published details at /.well-known/oauth-authorization-server (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/supabase/callback` on each
 * public origin) through Supabase's open registration (RFC 7591, scripts/register-oauth-client.mjs);
 * its id and secret live in SUPABASE_CLIENT_ID and SUPABASE_CLIENT_SECRET. Supabase offers only
 * clients with a secret.
 *
 * Supabase publishes 13 scopes. We ask for the read ones, so an agent can look at projects, the
 * database, logs, functions, environment and storage but never change them. `secrets:read` is left
 * out on purpose: it exposes project secrets to an agent. Adding the write scopes later means each
 * person signs in again. Supabase publishes no revocation endpoint, so none is set. A workspace that
 * already runs Supabase as a custom tool server is a separate entry and is not touched here.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'supabase',
	displayName: 'Supabase',
	description: 'Read Supabase projects, databases and logs through the Supabase MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://api.supabase.com/v1/oauth/authorize',
			tokenUrl: 'https://api.supabase.com/v1/oauth/token',
			scopes: [
				'organizations:read',
				'projects:read',
				'database:read',
				'analytics:read',
				'edge_functions:read',
				'environment:read',
				'storage:read',
			],
			pkce: true,
			clientIdEnv: 'SUPABASE_CLIENT_ID',
			clientSecretEnv: 'SUPABASE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.supabase.com/mcp'],
		envKey: 'SUPABASE_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.supabase.com/mcp',
			headers: { Authorization: 'Bearer ${SUPABASE_TOKEN}' },
		},
	},
}
