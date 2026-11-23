import type { ProviderConfig } from '../../types'

export const SALESFORCE_PROVIDER = 'salesforce'

const MCP_URL = 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all'

/**
 * Salesforce, through its hosted MCP server (sobject-all: read, create, update and delete records
 * across objects, plus query and search).
 *
 * Salesforce has no dynamic client registration for it. Each customer's admin creates an External
 * Client App in their own org (OAuth scopes mcp_api and refresh_token, "Require Secret for Web
 * Server Flow" on, callback URL = the one Settings shows) and pastes its Consumer Key and Secret
 * into Settings. That is customerApp: the workspace's own app is read at sign-in and at refresh,
 * and there is no Maskin-owned Salesforce app. SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET are
 * an optional server-wide fallback and are normally unset.
 *
 * Sources, all secondary because developer.salesforce.com and help.salesforce.com answer 403 to
 * our fetch (read 22 Nov 2026 through search summaries of those pages, not the pages themselves):
 * the server URL, the scopes and the manual client id and secret. The authorize and token URLs are
 * Salesforce's standard OAuth endpoints on login.salesforce.com. Unverified and so out of scope:
 * sandbox and scratch orgs (their server URL has a /sandbox segment and they sign in on
 * test.salesforce.com) and My Domain-only orgs that refuse login.salesforce.com.
 *
 * PKCE is sent (S256). Salesforce accepts it on the web server flow and an External Client App can
 * require it, so sending it is the safe side.
 */
export const config: ProviderConfig = {
	name: SALESFORCE_PROVIDER,
	displayName: 'Salesforce',
	description:
		'Read and update Salesforce records, run queries and search. Your Salesforce admin creates an External Client App once and you paste its key and secret here.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.salesforce.com/services/oauth2/authorize',
			tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
			revokeUrl: 'https://login.salesforce.com/services/oauth2/revoke',
			scopes: ['mcp_api', 'refresh_token'],
			pkce: true,
			tokenAuthMethod: 'client_secret_post',
			customerApp: true,
			clientIdEnv: 'SALESFORCE_CLIENT_ID',
			clientSecretEnv: 'SALESFORCE_CLIENT_SECRET',
		},
	},

	// No webhook or events block: records are read and changed on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', MCP_URL],
		envKey: 'SALESFORCE_TOKEN',
		server: {
			type: 'http',
			url: MCP_URL,
			headers: { Authorization: 'Bearer ${SALESFORCE_TOKEN}' },
		},
	},
}
