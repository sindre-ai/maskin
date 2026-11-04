import type { ProviderConfig } from '../../types'

/**
 * Google Search Console integration via standard OAuth2.
 *
 * Scope is deliberately locked to a single Google API surface — `webmasters`
 * (view and manage Search Console data) — with no identity/userinfo scopes. It
 * replaces `webmasters.readonly` because Google only lets the Sitemaps
 * submit/delete methods through the full scope; listing sites, search analytics
 * and URL Inspection accept either, so the daily sync is unchanged. Read-only is
 * now enforced by Maskin, not by Google: the sync only ever issues GETs and the
 * query POST, and the sitemap write tools are refused by the agent access gate
 * unless a person grants write. A connection made under the old scope shows
 * "needs reconnect" until it is reconnected, and keeps syncing meanwhile.
 * External-id resolution (which would need `userinfo.email`) is deferred until
 * sync + `gsc_data` writes need a per-property identity.
 *
 * OAuth client is shared with Gmail / Google Calendar (same Google Cloud
 * project, same consent screen). The env vars are named per-provider so
 * ops can point Search Console at a different client later without
 * touching Gmail/Calendar wiring.
 *
 * MCP is Maskin-hosted, like Google Meet: read tools (inspect_url, list_sites,
 * list_sitemaps, get_sitemap) and write tools (submit_sitemap, delete_sitemap) served
 * at `${MASKIN_API_URL}/api/integrations/google-search-console/mcp`.
 * The spec references only MASKIN_API_KEY, so the Search Console token is never
 * injected into a session; the route resolves it server-side. `autoInject: false`
 * so each agent opts in (or gets it through an access grant).
 */
export const config: ProviderConfig = {
	name: 'google-search-console',
	displayName: 'Google Search Console',
	description:
		'Daily Search Console sync. Sets search_demand on live content with a primary_keyword: the 30-day impressions for that query, scaled up for results below page 1. It is an estimate and a lower bound on monthly searches, not comparable to Ubersuggest volumes. Keywords with fewer than 10 impressions in the window are left unset, and a value typed by hand is never overwritten.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: ['https://www.googleapis.com/auth/webmasters'],
			pkce: true,
			// access_type=offline + prompt=consent are the documented way to force
			// Google to issue a refresh_token. Without them only the first connect
			// for a given (user, client) pair gets one.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
			},
			clientIdEnv: 'GOOGLE_SEARCH_CONSOLE_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET',
		},
	},

	mcp: {
		envKey: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/google-search-console/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}
