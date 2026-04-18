import type { ProviderConfig } from '../../types'

/**
 * Google Calendar OAuth2 provider.
 *
 * Used by the notetaker extension to sync calendar events into `meeting` objects.
 *
 * Required environment variables:
 * - GOOGLE_CALENDAR_CLIENT_ID
 * - GOOGLE_CALENDAR_CLIENT_SECRET
 *
 * `access_type=offline` + `prompt=consent` ensures Google returns a refresh token
 * on every consent grant (without `prompt=consent`, re-authorizations don't
 * issue a new refresh token, which breaks long-running token refresh).
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
				'https://www.googleapis.com/auth/calendar.events.readonly',
			],
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
			},
			clientIdEnv: 'GOOGLE_CALENDAR_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_CALENDAR_CLIENT_SECRET',
		},
	},
}
