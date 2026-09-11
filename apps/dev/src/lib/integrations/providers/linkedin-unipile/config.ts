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

	// Served in-process at /api/integrations/linkedin-unipile/mcp, same shape
	// as Slack's — the workspace's active linkedin-unipile integration is the
	// credential source, the route resolves it per request. autoInject means
	// every session for a workspace with LinkedIn connected gets the fan-out
	// tools without a per-agent MCP config change, matching the bet's product
	// intent ("first-party LinkedIn → agents can post/DM when the workspace has
	// connected it"). envKey is retained for symmetry with other providers; the
	// MCP route authenticates on the Maskin API key in the Authorization
	// header, not on a per-provider container env var, so nothing reads it at
	// runtime — but the McpConfig type requires it and setting it keeps the
	// discovery response (GET /api/integrations/providers) shaped consistently
	// with slack/gmail/linear.
	mcp: {
		envKey: 'LINKEDIN_UNIPILE_TOKEN',
		autoInject: true,
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
