import type { ProviderConfig } from '../../types'

/**
 * New Relic, through its hosted MCP server (https://mcp.newrelic.com/mcp/). The server's protected-resource
 * metadata names https://oauth2.service.newrelic.com as its authorization server, and the URLs below
 * are from that server's published details at /.well-known/oauth-authorization-server (checked 20 Nov
 * 2026). Registration is on dcr.service.newrelic.com.
 *
 * New Relic accepts a public client, so only NEW_RELIC_CLIENT_ID is set, registered once for Maskin's
 * callback (`/api/integrations/new-relic/callback` on each public origin) through its open
 * registration (RFC 7591, scripts/register-oauth-client.mjs --auth-method none).
 *
 * New Relic publishes `observability:read`, `alerts:modify`, `dashboards:modify` and the sign-in
 * scopes. We ask for `observability:read` and `offline_access` (so the token can be refreshed); the
 * two modify scopes are left out. The customer needs a paid plan and an organization admin has to
 * switch MCP on.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'new-relic',
	displayName: 'New Relic',
	description: 'Read New Relic telemetry and alerts through the New Relic MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://oauth2.service.newrelic.com/oauth2/auth',
			tokenUrl: 'https://oauth2.service.newrelic.com/oauth2/token',
			revokeUrl: 'https://oauth2.service.newrelic.com/oauth2/revoke',
			scopes: ['observability:read', 'offline_access'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'NEW_RELIC_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.newrelic.com/mcp/'],
		envKey: 'NEW_RELIC_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.newrelic.com/mcp/',
			headers: { Authorization: 'Bearer ${NEW_RELIC_TOKEN}' },
		},
	},
}
