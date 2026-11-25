import type { ProviderConfig } from '../../types'

export const WORDPRESS_SELF_HOSTED_PROVIDER = 'wordpress-self-hosted'

/**
 * A WordPress site the customer runs on their own server (not WordPress.com, not Jetpack). The
 * customer pastes the site address, a username and an application password (built into WordPress
 * since 5.6, created in the user's profile, needs https). It connects from a three-field form
 * (routes/integrations-wordpress-self-hosted.ts), mounted before the generic /api/integrations
 * routes; the generic connect route must not run for it.
 *
 * `auth.type = 'manual'`: there is no redirect and no token Maskin can renew. The three values are
 * one envelope-encrypted Keychain credential (./credentials.ts), read only through getCredential,
 * so every read is checked against the agent's grant and written to the audit trail.
 *
 * MCP is Maskin-hosted, like Deepdots: tools served at
 * `${MASKIN_API_URL}/api/integrations/wordpress-self-hosted/mcp` (./mcp-server.ts) call the site's
 * REST address (`/wp-json/wp/v2`). The spec references only MASKIN_API_KEY, so the application
 * password is never injected into a session; the route resolves it server-side. `autoInject: false`
 * so each agent opts in (or gets it through an access grant).
 *
 * Every call to the site goes through lib/integrations/safe-fetch.ts: https only, the name resolved
 * once and checked to be public, connected to that exact address, no redirects, a timeout and a cap
 * on the reply.
 */
export const config: ProviderConfig = {
	name: WORDPRESS_SELF_HOSTED_PROVIDER,
	displayName: 'WordPress (self-hosted)',
	description:
		'Read and edit posts, pages and media on a WordPress site you host yourself. New posts and pages are always drafts. Needs the site on https and an application password.',

	auth: { type: 'manual' },

	mcp: {
		envKey: 'WORDPRESS_SELF_HOSTED_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/wordpress-self-hosted/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}
