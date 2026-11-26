import type { ProviderConfig } from '../../types'

/**
 * HubSpot, through its hosted MCP server (https://mcp.hubspot.com). Its sign-in details are from
 * its published metadata at /.well-known/oauth-authorization-server (checked 22 Nov 2026, issuer
 * https://mcp.hubspot.com): code flow with PKCE S256, client_secret_post, no registration endpoint.
 *
 * Needs one MCP auth app that Maskin owns, created in a HubSpot developer account (HubSpot docs:
 * developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server).
 * Its client id and secret live in HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET, and its redirect
 * address is `/api/integrations/hubspot/callback` on each public origin. HubSpot publishes no scope
 * list for the server, so none is asked for here: the app's own settings decide what the token can
 * reach. HubSpot's general rule caps an app at 25 installs until it is approved in its Marketplace;
 * its docs do not say whether that applies to an MCP auth app (unverified).
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'hubspot',
	displayName: 'HubSpot',
	description:
		'Read HubSpot contacts, companies, deals and tickets. Needs an MCP auth app that Maskin owns in HubSpot.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mcp.hubspot.com/oauth/authorize/user',
			tokenUrl: 'https://mcp.hubspot.com/oauth/v3/token',
			scopes: [],
			pkce: true,
			clientIdEnv: 'HUBSPOT_CLIENT_ID',
			clientSecretEnv: 'HUBSPOT_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.hubspot.com'],
		envKey: 'HUBSPOT_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.hubspot.com',
			headers: { Authorization: 'Bearer ${HUBSPOT_TOKEN}' },
		},
	},
}
