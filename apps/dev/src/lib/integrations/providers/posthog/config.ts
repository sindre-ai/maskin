import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'posthog',
	displayName: 'PostHog',
	description: 'Behavioral analytics for product feedback loops via the PostHog MCP',

	auth: {
		type: 'api_key',
		config: {
			headerName: 'Authorization',
			headerPrefix: 'Bearer ',
			envKeyName: 'POSTHOG_PERSONAL_API_KEY',
		},
	},

	// No webhook config — PostHog data is pulled by the MCP on demand, not pushed.
	// No events block for the same reason: there are no inbound events to normalize.
}
