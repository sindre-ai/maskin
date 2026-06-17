import type { ProviderConfig } from '../../types'

/**
 * Google Calendar integration. Same OAuth2 shape as Gmail (Google offline
 * access with PKCE), but webhook delivery differs: Calendar push uses the
 * `events.watch` channel API, which POSTs directly to our URL with
 * `X-Goog-Channel-*` headers — not Pub/Sub. Verification is via the
 * `X-Goog-Channel-Token` set at watch-creation, validated in webhooks.ts.
 *
 * No MCP wiring — the Skjald integration reads calendar events server-side
 * to create `meeting` objects; agents talk to the meeting object, not to
 * Google directly.
 */
export const config: ProviderConfig = {
	name: 'google-calendar',
	displayName: 'Google Calendar',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: [
				'https://www.googleapis.com/auth/calendar.events.readonly',
				'https://www.googleapis.com/auth/calendar.readonly',
				'https://www.googleapis.com/auth/userinfo.email',
				'openid',
			],
			pkce: true,
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_CALENDAR_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_CALENDAR_CLIENT_SECRET',
		},
	},

	webhook: { type: 'custom' },

	events: {
		definitions: [
			{
				entityType: 'google-calendar.event',
				actions: ['created', 'updated', 'cancelled'],
				label: 'Calendar event',
			},
		],
	},
}
