import type { ProviderConfig } from '../../types'

/**
 * DocuSign, through its hosted MCP server (https://mcp.docusign.com/mcp). Its sign-in details are
 * from its published metadata (checked 22 Nov 2026): the server advertises six scopes and signs in
 * at https://account.docusign.com with PKCE S256 and no registration endpoint.
 *
 * Needs one integration key that Maskin owns. DocuSign's docs (developers.docusign.com/platform/mcp-server/)
 * say a custom connector needs its own integration key and production allow-listing through a
 * DocuSign form, so this stays hidden until that is done. The key lives in DOCUSIGN_CLIENT_ID and
 * DOCUSIGN_CLIENT_SECRET; the redirect address is `/api/integrations/docusign/callback`.
 *
 * Only `signature` (envelopes), `spring_read` and `adm_store_unified_repo_read` are asked for.
 * `signature` is DocuSign's own scope for envelopes and covers sending as well as reading, so a
 * write tool is held back by the per-agent read-only setting and the tool classification, not by
 * the scope. `spring_write`, `aow_manage` and `cors` are not asked for.
 *
 * Tools carry no curated read list: they are classified from the server's own annotations and
 * names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'docusign',
	displayName: 'DocuSign',
	description:
		'Read DocuSign envelopes and agreements. DocuSign must first allow Maskin on production accounts.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://account.docusign.com/oauth/auth',
			tokenUrl: 'https://account.docusign.com/oauth/token',
			scopes: ['signature', 'spring_read', 'adm_store_unified_repo_read'],
			pkce: true,
			clientIdEnv: 'DOCUSIGN_CLIENT_ID',
			clientSecretEnv: 'DOCUSIGN_CLIENT_SECRET',
		},
	},

	// No webhook or events block: data is searched and read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.docusign.com/mcp'],
		envKey: 'DOCUSIGN_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.docusign.com/mcp',
			headers: { Authorization: 'Bearer ${DOCUSIGN_TOKEN}' },
		},
	},
}
