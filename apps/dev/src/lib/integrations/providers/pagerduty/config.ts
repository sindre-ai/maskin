import type { ProviderConfig } from '../../types'

/**
 * PagerDuty, through its hosted MCP server (https://mcp.pagerduty.com/mcp). The server's protected-resource
 * metadata names https://app.pagerduty.com/global/oauth/anonymous as its authorization server, and
 * the URLs below are from that server's published details at
 * /.well-known/openid-configuration (checked 20 Nov 2026).
 *
 * PagerDuty accepts a public client, so only PAGERDUTY_CLIENT_ID is set, registered once for Maskin's
 * callback (`/api/integrations/pagerduty/callback` on each public origin) through its open
 * registration (RFC 7591, scripts/register-oauth-client.mjs --auth-method none).
 *
 * PagerDuty publishes a broad scope per resource (`incidents.read`, `services.write` and so on) and
 * the two general ones, `read` and `write`. We ask for `read` only; adding `write` later means each
 * person signs in again.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'pagerduty',
	displayName: 'PagerDuty',
	description: 'Read PagerDuty incidents, services and on-call through the PagerDuty MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.pagerduty.com/global/oauth/authorize',
			tokenUrl: 'https://app.pagerduty.com/global/oauth/token',
			revokeUrl: 'https://app.pagerduty.com/global/oauth/revoke',
			scopes: ['read'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'PAGERDUTY_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.pagerduty.com/mcp'],
		envKey: 'PAGERDUTY_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.pagerduty.com/mcp',
			headers: { Authorization: 'Bearer ${PAGERDUTY_TOKEN}' },
		},
	},
}
