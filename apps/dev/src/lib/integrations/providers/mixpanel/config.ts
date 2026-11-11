import type { ProviderConfig } from '../../types'

/**
 * Mixpanel, through its hosted MCP server (https://mcp.mixpanel.com/mcp, the US region; the EU
 * and India servers are separate and not listed). The server's protected-resource metadata names
 * https://auth.mixpanel.com as its authorization server, and the authorize and token URLs below are
 * from that server's published details at
 * https://auth.mixpanel.com/.well-known/oauth-authorization-server (checked 10 Nov 2026, issuer
 * https://auth.mixpanel.com).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/mixpanel/callback` on
 * each public origin) through Mixpanel's open registration (RFC 7591,
 * scripts/register-oauth-client.mjs); its id and secret live in MIXPANEL_CLIENT_ID and
 * MIXPANEL_CLIENT_SECRET. Mixpanel's token endpoint offers client_secret_post, client_secret_basic
 * and none; the default (post) is used. PKCE is S256 only.
 *
 * Scopes are all 24 that Mixpanel publishes: some read (data:read, insights), some change things
 * (annotations, custom events, feature flags). A read-only agent stays read-only at the MCP gateway
 * (GATEWAY_PROVIDERS), not through a narrower sign-in. No revocation endpoint is published, so none
 * is set. Tools carry no curated read list: they are classified from the server's own annotations
 * and names, and an unknown tool is a write.
 */
export const config: ProviderConfig = {
	name: 'mixpanel',
	displayName: 'Mixpanel',
	description: 'Read Mixpanel reports, events and users through the Mixpanel MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://mixpanel.com/oauth/authorize',
			tokenUrl: 'https://mixpanel.com/oauth/token/',
			scopes: [
				'projects',
				'analysis',
				'events',
				'insights',
				'segmentation',
				'retention',
				'data:read',
				'funnels',
				'flows',
				'data_definitions',
				'alerts',
				'annotations',
				'bookmarks',
				'business_context',
				'cohorts',
				'context',
				'custom_alerts',
				'custom_events',
				'custom_properties',
				'dashboard_reports',
				'experiments',
				'feature_flags',
				'metrics',
				'user_details',
			],
			pkce: true,
			clientIdEnv: 'MIXPANEL_CLIENT_ID',
			clientSecretEnv: 'MIXPANEL_CLIENT_SECRET',
		},
	},

	// No webhook or events block: reports and events are read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.mixpanel.com/mcp'],
		envKey: 'MIXPANEL_TOKEN',
		server: {
			type: 'http',
			url: 'https://mcp.mixpanel.com/mcp',
			headers: { Authorization: 'Bearer ${MIXPANEL_TOKEN}' },
		},
	},
}
