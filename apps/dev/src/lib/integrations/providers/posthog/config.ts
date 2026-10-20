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
		},
	},

	// No webhook config — PostHog data is pulled by the MCP on demand, not pushed.
	// No events block for the same reason: there are no inbound events to normalize.

	// First external (not first-party @maskin/ext-*) MCP server — see ADR in the
	// posthog-loop bet thread. autoInject = every agent session in a workspace
	// with an active PostHog integration gets the MCP, no per-agent config
	// required. The quick-add button (GET /api/integrations/mcp-presets) is
	// derived from this `server`, so it and the auto-injected server are the
	// same shape by construction.
	mcp: {
		envKey: 'POSTHOG_TOKEN',
		autoInject: true,
		server: {
			type: 'http',
			url: 'https://mcp.posthog.com/mcp',
			headers: { Authorization: 'Bearer ${POSTHOG_TOKEN}' },
		},
	},
}
