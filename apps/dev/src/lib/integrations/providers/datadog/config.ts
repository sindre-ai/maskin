import type { ProviderConfig } from '../../types'

/**
 * Datadog, through its hosted MCP server (https://mcp.datadoghq.com/v1/mcp). The URLs below are from its
 * published details at /.well-known/oauth-authorization-server/v1/mcp (checked 20 Nov 2026, issuer
 * https://mcp.datadoghq.com/v1/mcp). Sign-in, token and registration are on app.datadoghq.com.
 *
 * Datadog offers only public clients, so only DATADOG_CLIENT_ID is set, registered once for Maskin's
 * callback (`/api/integrations/datadog/callback` on each public origin) through its open registration
 * (RFC 7591, scripts/register-oauth-client.mjs --auth-method none).
 *
 * This is the US1 site only. Datadog runs other sites (EU, US3, US5 and more) on their own hosts, and
 * a workspace on one of them cannot connect through this entry. An organization admin also has to
 * allow MCP access in Datadog before a sign-in works. Datadog publishes one scope, `mcp_all`, and no
 * revocation endpoint.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'datadog',
	displayName: 'Datadog',
	description: 'Read Datadog metrics, logs and monitors through the Datadog MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://app.datadoghq.com/oauth2/v1/authorize',
			tokenUrl: 'https://app.datadoghq.com/api/v2/oauth2/token',
			scopes: ['mcp_all'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'DATADOG_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.datadoghq.com/v1/mcp'],
		envKey: 'DATADOG_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.datadoghq.com/v1/mcp',
			headers: { Authorization: 'Bearer ${DATADOG_TOKEN}' },
		},
	},
}
