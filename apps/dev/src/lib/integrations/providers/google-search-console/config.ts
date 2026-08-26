import type { ProviderConfig } from '../../types'

/**
 * Google Search Console integration via standard OAuth2.
 *
 * Scope is deliberately locked to a single Google API surface —
 * `webmasters.readonly` — with no identity/userinfo scopes. This mirrors the
 * task-1 "no scope creep" bar: a reviewer checking `config.auth.config.scopes`
 * sees exactly one entry, and the OAuth consent screen shows only Search
 * Console read access. External-id resolution (which would need
 * `userinfo.email`) is deferred to task 2 when sync + `gsc_data` writes need
 * a per-property identity.
 *
 * OAuth client is shared with Gmail / Google Calendar (same Google Cloud
 * project, same consent screen). The env vars are named per-provider so
 * ops can point Search Console at a different client later without
 * touching Gmail/Calendar wiring.
 *
 * MCP wiring, daily sync, backfill, and PostHog emission are out of scope
 * for task 1 and land in tasks 2–4.
 */
export const config: ProviderConfig = {
	name: 'google-search-console',
	displayName: 'Google Search Console',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
			pkce: true,
			// access_type=offline + prompt=consent are the documented way to force
			// Google to issue a refresh_token. Without them only the first connect
			// for a given (user, client) pair gets one.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_SEARCH_CONSOLE_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET',
		},
	},
}
