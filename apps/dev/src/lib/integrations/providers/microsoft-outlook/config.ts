import type { ProviderConfig } from '../../types'

/**
 * Microsoft Outlook (Graph) OAuth2 provider.
 *
 * Used by the notetaker extension to sync calendar events into `meeting` objects.
 *
 * Required environment variables:
 * - MICROSOFT_OUTLOOK_CLIENT_ID
 * - MICROSOFT_OUTLOOK_CLIENT_SECRET
 *
 * `offline_access` is required to receive a refresh token from Microsoft Identity.
 */
export const config: ProviderConfig = {
	name: 'microsoft-outlook',
	displayName: 'Microsoft Outlook',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
			tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			scopes: ['Calendars.Read', 'offline_access'],
			clientIdEnv: 'MICROSOFT_OUTLOOK_CLIENT_ID',
			clientSecretEnv: 'MICROSOFT_OUTLOOK_CLIENT_SECRET',
		},
	},
}
