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
	// each admined page). `autoInject` is false on purpose (Magnus 2026-09-14
	// reversal of the workspace-wide auto-inject that shipped in PR #1595 / bet
	// 56c2ffd7): a workspace with many agents does not want every agent silently
	// attached to every LinkedIn identity — the operator picks per-agent, per-
	// identity. envKey is retained for symmetry with other providers; the MCP
	// route authenticates on the Maskin API key in the Authorization header,
	// not on a per-provider container env var.
	//
	// Deliberately no `server`, matching github. linkedin-unipile is multi-
	// identity: the frontend Quick Add UI enumerates identities from
	// /api/integrations/linkedin-unipile/identities and writes one mcpServers
	// entry per identity, each targeting the per-slug URL. There is no single
	// paste-ready `.../mcp` shape to hand out — the aggregate URL is a
	// deprecated, empty-tool endpoint (see routes/integrations-linkedin-unipile-mcp.ts)
	// and advertising it as the canonical discovery answer would silently trap
	// any non-browser client that pastes the discovery spec verbatim. Discovery
	// clients see `mcp: { envKey, autoInject: false }` with no `server` — the
	// same "no single spec" signal github uses for its per-installation surface.
	// The route test enumerating which providers omit `server` in
	// `integrations.test.ts` is what holds this line.
	mcp: {
		envKey: 'LINKEDIN_UNIPILE_TOKEN',
		autoInject: false,
	},

	externalIdDisplay: 'installation',
}
