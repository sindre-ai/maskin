import type { ProviderConfig } from '../../types'

/**
 * Figma, through its hosted MCP server (https://mcp.figma.com/mcp). Its sign-in details are from
 * its published metadata (checked 22 Nov 2026, issuer https://api.figma.com): code flow with PKCE
 * S256, client_secret_basic or client_secret_post, one scope `mcp:connect`.
 *
 * Figma's registration endpoint answers 403 for any client outside its MCP catalog, and its docs say
 * only catalog clients can connect (manual vetting). So Maskin must be accepted into the catalog
 * first; until then FIGMA_CLIENT_ID is unset and the tile stays hidden. Register with
 * scripts/register-oauth-client.mjs once Figma has approved Maskin. The client id and secret live in
 * FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET; the redirect address is `/api/integrations/figma/callback`.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'figma',
	displayName: 'Figma',
	description:
		'Read Figma designs and files for agents. Figma must approve Maskin as an MCP client first.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://www.figma.com/oauth/mcp',
			tokenUrl: 'https://api.figma.com/v1/oauth/token',
			scopes: ['mcp:connect'],
			pkce: true,
			clientIdEnv: 'FIGMA_CLIENT_ID',
			clientSecretEnv: 'FIGMA_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.figma.com/mcp'],
		envKey: 'FIGMA_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.figma.com/mcp',
			headers: { Authorization: 'Bearer ${FIGMA_TOKEN}' },
		},
	},
}
