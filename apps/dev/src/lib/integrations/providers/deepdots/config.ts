import type { ProviderConfig } from '../../types'

/**
 * Deepdots (also MagicFeedback) hands out a one-hour token in exchange for an
 * email and a password, so it cannot use the one-saved-key path. A person
 * connects from a two-field form (routes/integrations-deepdots.ts); the stored
 * login is what keeps the token renewed (./auth.ts).
 *
 * `auth.type = 'oauth2_custom'` is a sentinel, the same way it is for
 * linkedin-unipile: it makes TokenManager use `customAuth` for renewal while the
 * connect route lives outside the generic OAuth one. The generic connect route
 * must not run for this provider.
 *
 * MCP is Maskin-hosted, like Search Console: four read tools served at
 * `${MASKIN_API_URL}/api/integrations/deepdots/mcp`. The spec references only
 * MASKIN_API_KEY, so the Deepdots token is never injected into a session; the route
 * resolves it server-side. `autoInject: false` so each agent opts in (or gets it
 * through an access grant).
 */
export const config: ProviderConfig = {
	name: 'deepdots',
	displayName: 'Deepdots',
	description: 'Customer feedback insights, issues and opportunities from Deepdots (read only)',

	auth: { type: 'oauth2_custom' },

	externalIdDisplay: 'email',

	mcp: {
		envKey: 'DEEPDOTS_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/deepdots/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}
