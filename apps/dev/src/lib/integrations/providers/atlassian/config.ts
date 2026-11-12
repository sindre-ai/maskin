import type { ProviderConfig } from '../../types'

/**
 * Atlassian (Jira and Confluence), through its hosted MCP server v2 (https://mcp.atlassian.com/v2/mcp).
 * The v1 address (/v1/mcp, /v1/sse) is retired on 1 Mar 2027, so only v2 is used here.
 *
 * The server's protected-resource metadata (/.well-known/oauth-protected-resource/v2/mcp, checked
 * 9 Nov 2026) names one authorization server, https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3,
 * and that server's published details (/.well-known/oauth-authorization-server under the same path)
 * give the authorize and token URLs below and a registration address on atlassian.com.
 * Atlassian's older MCP host (mcp.atlassian.com/v1/authorize) is not used.
 *
 * The client is registered once for Maskin's callback (`/api/integrations/atlassian/callback`
 * on each public origin) through that registration address (RFC 7591, scripts/register-oauth-client.mjs);
 * its id and secret live in ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET.
 *
 * Read and write scopes for Jira and Confluence are both requested up front, because a token never
 * gains a scope later; offline_access gives the refresh token. Delete and manage scopes are left out.
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS), not through a narrower
 * sign-in. Tools carry no curated read list: they are classified from the server's own annotations
 * and names, and an unknown tool is a write. The revocation endpoint is not set because the
 * handler's revoke call is not used on disconnect for any provider.
 */
export const config: ProviderConfig = {
	name: 'atlassian',
	displayName: 'Atlassian',
	description: 'Read and edit Jira and Confluence through the Atlassian MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://auth.atlassian.com/authorize',
			tokenUrl: 'https://auth.atlassian.com/oauth/token',
			scopes: [
				'offline_access',
				'read:me',
				'read:jira:agent-interface',
				'write:jira:agent-interface',
				'search:jira:agent-interface',
				'read:confluence:agent-interface',
				'write:confluence:agent-interface',
				'search:confluence:agent-interface',
			],
			pkce: true,
			clientIdEnv: 'ATLASSIAN_CLIENT_ID',
			clientSecretEnv: 'ATLASSIAN_CLIENT_SECRET',
		},
	},

	// No webhook or events block: issues and pages are read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v2/mcp'],
		envKey: 'ATLASSIAN_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.atlassian.com/v2/mcp',
			headers: { Authorization: 'Bearer ${ATLASSIAN_TOKEN}' },
		},
	},
}
