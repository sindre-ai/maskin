import type { ProviderConfig } from '../../types'

/**
 * Xero, through its hosted MCP server (https://api.xero.com/mcp/v1). Its sign-in details are from
 * its published metadata (checked 22 Nov 2026, issuer https://identity.xero.com): code flow with PKCE
 * S256, client_secret_basic or client_secret_post, no registration endpoint.
 *
 * Needs one app that Maskin owns, created in the Xero developer portal. Xero's FAQ
 * (developer.xero.com/faq/remote-mcp) says Plus, Advanced and Enterprise apps must be certified and an
 * uncertified app is capped per organisation, so a person must check the plan before this goes live.
 * Id and secret live in XERO_CLIENT_ID and XERO_CLIENT_SECRET; the redirect address is
 * `/api/integrations/xero/callback`.
 *
 * Only the read scopes the server advertises are asked for (invoices, bank transactions, contacts,
 * payments, manual journals, settings and the four reports), plus `offline_access` for the refresh
 * token. Token auth is client_secret_basic because Xero's revocation needs it.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'xero',
	displayName: 'Xero',
	description:
		'Read Xero invoices, contacts, bank transactions and reports. Xero must certify the app once it passes its organisation cap.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.xero.com/identity/connect/authorize',
			tokenUrl: 'https://identity.xero.com/connect/token',
			revokeUrl: 'https://identity.xero.com/connect/revocation',
			scopes: [
				'offline_access',
				'accounting.invoices.read',
				'accounting.banktransactions.read',
				'accounting.contacts.read',
				'accounting.payments.read',
				'accounting.manualjournals.read',
				'accounting.settings.read',
				'accounting.reports.profitandloss.read',
				'accounting.reports.trialbalance.read',
				'accounting.reports.balancesheet.read',
				'accounting.reports.aged.read',
			],
			pkce: true,
			tokenAuthMethod: 'client_secret_basic',
			clientIdEnv: 'XERO_CLIENT_ID',
			clientSecretEnv: 'XERO_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://api.xero.com/mcp/v1'],
		envKey: 'XERO_TOKEN',
		server: {
			type: 'http',
			url: 'https://api.xero.com/mcp/v1',
			headers: { Authorization: 'Bearer ${XERO_TOKEN}' },
		},
	},
}
