import type { ProviderConfig } from '../../types'

export const POWER_BI_PROVIDER = 'power-bi'

const MCP_URL = 'https://api.fabric.microsoft.com/v1/mcp/powerbi'

/**
 * Power BI, through Microsoft's remote Power BI MCP server (consumption: run DAX queries, read model
 * schemas and report metadata). Server address from
 * https://learn.microsoft.com/en-us/power-bi/developer/mcp/remote-mcp-server-get-started (read
 * 22 Nov 2026). It is in preview, and the page says Microsoft prefers the Fabric IQ server for new
 * work. A Power BI admin must also switch on the tenant setting "Users can use the Power BI Model
 * Context Protocol server endpoint (preview)".
 *
 * Sign-in is Microsoft Entra on the customer's own tenant: the standard v2.0 authorize and token
 * endpoints at login.microsoftonline.com, with {value} the tenant id (customerValue). The scope is
 * https://analysis.windows.net/powerbi/api/.default, not an api.fabric.microsoft.com scope.
 *
 * Each customer registers their own Entra app (web redirect = the callback URL Settings shows,
 * delegated Power BI permissions with admin consent, a client secret) and pastes its application
 * id and secret. That is customerApp. It is a separate sign-in from the Microsoft provider (Graph
 * scopes), because a token has one audience.
 *
 * Not verified: no live sign-in. A forum report from March 2026 says clients that send the older
 * resource parameter on the v2.0 authorize URL are refused by this server (AADSTS9010010). Maskin
 * sends scope only, so it should not be hit, but that is untested.
 */
export const config: ProviderConfig = {
	name: POWER_BI_PROVIDER,
	displayName: 'Power BI',
	description:
		'Query Power BI semantic models and read report details. Your Microsoft admin creates an app once, and you paste its application ID, secret and your tenant ID here.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.microsoftonline.com/{value}/oauth2/v2.0/authorize',
			tokenUrl: 'https://login.microsoftonline.com/{value}/oauth2/v2.0/token',
			scopes: ['offline_access', 'https://analysis.windows.net/powerbi/api/.default'],
			pkce: true,
			tokenAuthMethod: 'client_secret_post',
			customerApp: true,
			customerValue: {
				label: 'Tenant ID',
				placeholder: '11111111-2222-3333-4444-555555555555',
				help: 'The directory (tenant) ID of your Microsoft account, from the app registration page.',
				kind: 'tenant',
			},
			clientIdEnv: 'POWER_BI_CLIENT_ID',
			clientSecretEnv: 'POWER_BI_CLIENT_SECRET',
		},
	},

	// No webhook or events block: models and reports are read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', MCP_URL],
		envKey: 'POWER_BI_TOKEN',
		server: {
			type: 'http',
			url: MCP_URL,
			headers: { Authorization: 'Bearer ${POWER_BI_TOKEN}' },
		},
	},
}
