import type { ProviderConfig, StoredCredentials } from '../../types'

export const BUSINESS_CENTRAL_PROVIDER = 'business-central'

const API_SCOPE = 'https://api.businesscentral.dynamics.com/Financials.ReadWrite.All'

/**
 * Microsoft Dynamics 365 Business Central, through Microsoft's own hosted MCP server
 * (https://mcp.businesscentral.dynamics.com, Business Central online only, streamable HTTP).
 * Read from Microsoft's docs on 24 Nov 2026 (use-mcp-server-non-microsoft, configure-mcp-server);
 * not yet run against a live tenant.
 *
 * Sign-in. Entra ID has no dynamic client registration, so a client that is not Microsoft's own
 * needs its own Entra app: Maskin's, registered once as "Multiple Entra ID tenants", with the
 * delegated permission Financials.ReadWrite.All on Dynamics 365 Business Central and the redirect
 * URI `/api/integrations/business-central/callback` of each public origin. The redirect goes under
 * the "Mobile and desktop applications" platform with public client flows allowed, because the
 * app has no secret: PKCE only, like Uniconta (BUSINESS_CENTRAL_CLIENT_ID is the only setting).
 * The permission needs no admin consent by itself, but a customer's admin may have switched user
 * consent off, and then has to approve Maskin's app once. Work or school accounts only: Business
 * Central online signs in through Entra.
 *
 * Headers. The server asks for TenantId, EnvironmentName and Company unless the client can leave
 * them out. TenantId is left out (the server takes the tenant from the signed-in identity) and so
 * is Company (the server then runs in dynamic tool mode and offers list_companies, and every call
 * carries a company). EnvironmentName is sent as a fixed "Production", the name of a trial or
 * live online environment. A customer whose environment has another name needs per-connection
 * header values in the gateway, which this does not build.
 *
 * What an agent can reach is set on the customer's side. The built-in default configuration has
 * dynamic tool mode and read-only discovery on, so items, vendors, customers and sales or purchase
 * orders are readable with no setup, for the pages the signed-in user may read. Create, change,
 * delete and actions exist only where the admin unblocked edit tools in an active configuration.
 * Maskin adds no write switch of its own beyond the agent's Read or Read and write grant, which
 * the gateway applies (see tool-kinds.ts).
 *
 * Microsoft says it will charge for MCP tools later, with no price published.
 */
export const config: ProviderConfig = {
	name: BUSINESS_CENTRAL_PROVIDER,
	displayName: 'Business Central',
	description:
		'Read items, vendors, customers and orders in Microsoft Dynamics 365 Business Central online. Work or school accounts only. Your admin may need to approve Maskin once, and Microsoft plans to charge for these tools (price not published).',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
			tokenUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
			scopes: ['offline_access', API_SCOPE],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'BUSINESS_CENTRAL_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.businesscentral.dynamics.com'],
		envKey: 'BUSINESS_CENTRAL_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.businesscentral.dynamics.com',
			headers: {
				Authorization: 'Bearer ${BUSINESS_CENTRAL_TOKEN}',
				EnvironmentName: 'Production',
			},
		},
	},
}

/**
 * Entra never lists offline_access in a token response, even when it issued a refresh token
 * because of it. Left alone the scope-drift check would read it as missing and show "Reconnect
 * needed" on every healthy connection, so it is added back when a refresh token came with the
 * response. Same approach as the Azure DevOps provider; not yet seen against a live Business
 * Central token response.
 */
export function parseTokenResponse(raw: unknown): Partial<StoredCredentials> {
	if (typeof raw !== 'object' || raw === null) return {}
	const body = raw as Record<string, unknown>
	if (typeof body.scope !== 'string') return {}
	const granted = body.scope.split(/\s+/).filter(Boolean)
	const implied = [API_SCOPE, ...(typeof body.refresh_token === 'string' ? ['offline_access'] : [])]
	const missing = implied.filter((scope) => !granted.includes(scope))
	return missing.length > 0 ? { scope: [...granted, ...missing].join(' ') } : {}
}
