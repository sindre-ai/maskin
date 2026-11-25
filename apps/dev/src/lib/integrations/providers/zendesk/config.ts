import type { ProviderConfig } from '../../types'

export const ZENDESK_PROVIDER = 'zendesk'

/**
 * Zendesk, through its MCP server (early access, read 22 Nov 2026 on
 * https://support.zendesk.com/hc/en-us/articles/11400026079130-Connecting-external-AI-agents-to-Zendesk-EAP).
 * Every address is the customer's own Zendesk: the server is at {value}/mcp, sign-in at
 * {value}/oauth/authorizations/new and the token at {value}/oauth/tokens. {value} is the host of
 * the core Zendesk address (acme.zendesk.com), not a host-mapped one
 * (https://support.zendesk.com/hc/en-us/articles/4408845965210).
 *
 * Zendesk has no dynamic client registration. A Zendesk admin creates an OAuth client in Admin
 * Center and pastes its id and secret here, with the Zendesk address. That page says to leave
 * "Allowed scopes" blank, so the sign-in asks for no scope.
 *
 * Only zendesk.com is accepted for the address, so a typed host can never point our server at
 * anything but Zendesk.
 *
 * Not verified: which scopes the MCP server needs (the early access page names none), whether
 * PKCE is accepted (so it is off), whether a refresh token is
 * issued, and that the address stays the same once the server leaves early access. No live
 * sign-in has been tried.
 */
export const config: ProviderConfig = {
	name: ZENDESK_PROVIDER,
	displayName: 'Zendesk',
	description:
		'Search and work on tickets in Zendesk. Your Zendesk admin creates an OAuth client in Admin Center once, and you paste its client ID, its secret and your Zendesk address here.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://{value}/oauth/authorizations/new',
			tokenUrl: 'https://{value}/oauth/tokens',
			scopes: [],
			tokenAuthMethod: 'client_secret_post',
			customerApp: true,
			customerValue: {
				label: 'Zendesk address',
				placeholder: 'yourcompany.zendesk.com',
				help: 'Your Zendesk address, without https://. It must end in .zendesk.com, not a custom domain.',
				kind: 'host',
				hostSuffixes: ['zendesk.com'],
			},
			clientIdEnv: 'ZENDESK_CLIENT_ID',
			clientSecretEnv: 'ZENDESK_CLIENT_SECRET',
		},
	},

	// No webhook or events block: tickets are read and changed on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://{value}/mcp'],
		envKey: 'ZENDESK_TOKEN',
		server: {
			type: 'http',
			url: 'https://{value}/mcp',
			headers: { Authorization: 'Bearer ${ZENDESK_TOKEN}' },
		},
	},
}
