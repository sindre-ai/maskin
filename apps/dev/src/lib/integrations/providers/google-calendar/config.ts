import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'google-calendar',
	displayName: 'Google Calendar',
	description: 'Connect Google Calendar to automatically record meetings',

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
