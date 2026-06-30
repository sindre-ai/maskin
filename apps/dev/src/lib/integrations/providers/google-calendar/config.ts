import type { ProviderConfig } from '../../types'

/**
 * Google Calendar integration via standard OAuth2.
 *
 * Scopes are deliberately split — `calendar.readonly` for list/free-busy and
 * `calendar.events` for create/update/RSVP — instead of the broader `calendar`
 * scope, so the consent screen shows exactly what we use and revoking write
 * access (or future audit) can dial blast-radius down to read-only.
 *
 * Webhook delivery (Calendar push channels) and MCP tool wiring land in
 * downstream tasks; T1 only stands up the OAuth connect surface.
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
				'https://www.googleapis.com/auth/calendar.readonly',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/userinfo.email',
				'openid',
			],
			pkce: true,
			// access_type=offline + prompt=consent are the documented way to force
			// Google to issue a refresh_token. Without them only the first connect
			// for a given (user, client) pair gets one.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_CALENDAR_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_CALENDAR_CLIENT_SECRET',
		},
	},
}
