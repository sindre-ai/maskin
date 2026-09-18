import type { ProviderConfig } from '../../types'

/**
 * linkedin-unipile provider config.
 *
 * Registered in the integration registry so it shows up in
 * GET /api/integrations/providers (which the Settings > Integrations page
 * reads via `list_integration_providers`). The actual connect + callback
 * routes live in `apps/dev/src/routes/integrations-linkedin-unipile.ts`
 * because the LinkedIn Hosted Auth Wizard is NOT OAuth2 — see spec §2.
 *
 * `auth.type = 'oauth2_custom'` is a sentinel here: it keeps the provider
 * out of the generic OAuth2 handler's path (which would try to build an
 * authorization URL) while still satisfying ProviderConfig's discriminated
 * union. The generic /{provider}/connect handler explicitly early-returns
 * for this provider name and directs the caller to the dedicated route.
 */
export const config: ProviderConfig = {
	name: 'linkedin-unipile',
	displayName: 'LinkedIn',
	description:
		'Send LinkedIn DMs and read conversations on behalf of the connected member via LinkedIn.',

	auth: {
		type: 'oauth2_custom',
	},

	// Served in-process at /api/integrations/linkedin-unipile/mcp/:instanceSlug —
	// one MCP endpoint per connected LinkedIn identity (personal profile plus
	// each admined page). The provider surfaces one canonical `server` spec here
	// for the GET /api/integrations/providers discovery contract, but this shape
	// is NOT what the frontend Quick Add uses — the mcp-servers Quick Add UI
	// enumerates per-identity endpoints from /api/integrations/linkedin-unipile/identities
	// and writes one mcpServers entry per identity. `autoInject` is false on
	// purpose (Magnus 2026-09-14 reversal of the workspace-wide auto-inject that
	// shipped in PR #1595 / bet 56c2ffd7): a workspace with many agents does not
	// want every agent silently attached to every LinkedIn identity — the
	// operator picks per-agent, per-identity. envKey is retained for symmetry
	// with other providers; the MCP route authenticates on the Maskin API key
	// in the Authorization header, not on a per-provider container env var.
	mcp: {
		envKey: 'LINKEDIN_UNIPILE_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},

	externalIdDisplay: 'installation',
}
