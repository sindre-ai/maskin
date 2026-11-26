import type { ProviderConfig } from '../../types'

export const LOOKER_PROVIDER = 'looker'

/**
 * Looker, through its managed MCP server (https://docs.cloud.google.com/looker/docs/mcp, read
 * 22 Nov 2026). Every address is the customer's own instance: the server is at {instance}/mcp,
 * sign-in at {instance}/auth and the token at {instance}/api/token, with the single scope cors_api.
 * {value} is that instance's host name (customerValue).
 *
 * Looker has no dynamic client registration. A Looker admin registers an OAuth client on the
 * instance (Admin, Manage OAuth Clients, or the oauth_client_apps API) with the callback URL
 * Settings shows, and pastes its client id here. The docs set it up as a public client with PKCE
 * and no secret, so this is tokenAuthMethod 'none' and the form asks for no secret.
 *
 * Only Looker's own domains are accepted for the instance (looker.com, which covers the
 * *.cloud.looker.com hosted instances, and looker.app for Looker on Google Cloud). A customer-hosted
 * Looker on its own domain is left out on purpose: that would let a typed host name make our server
 * call any public address.
 *
 * Not verified: that a refresh token is issued (the docs do not say). If it is not, the connection
 * has to be redone when the access token expires. No live sign-in has been tried.
 */
export const config: ProviderConfig = {
	name: LOOKER_PROVIDER,
	displayName: 'Looker',
	description:
		'Explore models, run queries and read dashboards in Looker. Your Looker admin registers an OAuth client once, and you paste its client ID and your Looker address here.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://{value}/auth',
			tokenUrl: 'https://{value}/api/token',
			scopes: ['cors_api'],
			pkce: true,
			tokenAuthMethod: 'none',
			customerApp: true,
			customerValue: {
				label: 'Looker address',
				placeholder: 'yourcompany.cloud.looker.com',
				help: 'The address of your Looker instance, without https://. Only looker.com and looker.app addresses work.',
				kind: 'host',
				hostSuffixes: ['looker.com', 'looker.app'],
			},
			clientIdEnv: 'LOOKER_CLIENT_ID',
		},
	},

	// No webhook or events block: dashboards and queries are read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://{value}/mcp'],
		envKey: 'LOOKER_TOKEN',
		server: {
			type: 'http',
			url: 'https://{value}/mcp',
			headers: { Authorization: 'Bearer ${LOOKER_TOKEN}' },
		},
	},
}
