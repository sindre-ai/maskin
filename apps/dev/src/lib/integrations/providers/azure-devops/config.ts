import type { ProviderConfig, StoredCredentials } from '../../types'

export const AZURE_DEVOPS_PROVIDER = 'azure-devops'

const MCP_SCOPE = 'https://mcp.dev.azure.com/.default'

/**
 * Azure DevOps, through Microsoft's hosted MCP server (https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server).
 * Work or school accounts only: the organisation has to be backed by Microsoft Entra, and personal
 * Microsoft accounts are refused at sign-in.
 *
 * The server's own metadata (/.well-known/oauth-protected-resource/{org}, checked 19 Nov 2026) names
 * one sign-in authority, https://login.microsoftonline.com/organizations/v2.0, and one scope,
 * https://mcp.dev.azure.com/.default. A token carries a single audience, so the token of the
 * Microsoft provider (Graph scopes, for Teams transcripts) is not accepted here: this is its own
 * sign-in. It reuses the same Entra app registration (MICROSOFT_CLIENT_ID and
 * MICROSOFT_CLIENT_SECRET); that registration needs the delegated permission on the Azure DevOps
 * MCP enterprise app (2a72489c-aab2-4b65-b93a-a91edccf33b8), a redirect URI for
 * `/api/integrations/azure-devops/callback`, and each customer's admin consent.
 *
 * No organisation in the URL: the server also answers at https://mcp.dev.azure.com/ and then takes
 * the organisation as context in each tool call (core_list_orgs lists the ones the person can
 * reach). So one connection covers every organisation the account belongs to, and Maskin never
 * puts a typed organisation name into a URL the bearer token is sent to.
 *
 * Toolsets are fixed here to repos, wit and pipelines (X-MCP-Toolsets); the core tools are always on.
 * Read-only is per agent: `readOnlyHeaders` is sent as well whenever the agent's access is Read,
 * on top of the gateway's own refusal of write tools (GATEWAY_PROVIDERS). The gateway classifies
 * tools from the server's own annotations and names; an unknown tool counts as a write.
 */
export const config: ProviderConfig = {
	name: AZURE_DEVOPS_PROVIDER,
	displayName: 'Azure DevOps',
	description:
		'Read repos, pull requests, work items and builds in Azure DevOps. Work or school accounts only: the organisation must be backed by Microsoft Entra.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
			tokenUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
			scopes: ['offline_access', MCP_SCOPE],
			pkce: true,
			clientIdEnv: 'MICROSOFT_CLIENT_ID',
			clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
		},
	},

	// No webhook or events block: everything is read and edited on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.dev.azure.com/'],
		envKey: 'AZURE_DEVOPS_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.dev.azure.com/',
			headers: {
				Authorization: 'Bearer ${AZURE_DEVOPS_TOKEN}',
				'X-MCP-Toolsets': 'repos,wit,pipelines',
			},
		},
		readOnlyHeaders: { 'X-MCP-Readonly': 'true' },
	},
}

/**
 * Entra answers a "/.default" request with the delegated scopes it resolved to on that resource,
 * never with ".default" itself, and never lists offline_access even when it issued a refresh token
 * because of it. Left alone, the scope-drift check would read both as missing and show "Reconnect
 * needed" on every healthy connection. A token only comes back for a request that asked for both,
 * so adding them back is accurate. Written from how the Microsoft provider behaves; not yet seen
 * against a live Azure DevOps token response.
 */
export function parseTokenResponse(raw: unknown): Partial<StoredCredentials> {
	if (typeof raw !== 'object' || raw === null) return {}
	const body = raw as Record<string, unknown>
	if (typeof body.scope !== 'string') return {}
	const granted = body.scope.split(/\s+/).filter(Boolean)
	const implied = [MCP_SCOPE, ...(typeof body.refresh_token === 'string' ? ['offline_access'] : [])]
	const missing = implied.filter((scope) => !granted.includes(scope))
	return missing.length > 0 ? { scope: [...granted, ...missing].join(' ') } : {}
}
