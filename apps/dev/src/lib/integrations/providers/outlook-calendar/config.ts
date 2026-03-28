import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'outlook-calendar',
	displayName: 'Outlook Calendar',
	description: 'Connect Microsoft 365 Calendar to automatically record meetings',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
			tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			scopes: ['Calendars.Read', 'offline_access'],
			clientIdEnv: 'OUTLOOK_CLIENT_ID',
			clientSecretEnv: 'OUTLOOK_CLIENT_SECRET',
		},
	},
}
