import type { ProviderConfig } from '../../types'

/**
 * Gmail integration via standard OAuth2 + Cloud Pub/Sub push notifications.
 *
 * Webhook delivery is handled as `type: 'custom'`: Google's Pub/Sub push signs
 * each request with an OIDC JWT in the Authorization header (verified in webhooks.ts).
 *
 * MCP wiring lives entirely on the frontend (INTEGRATION_MCP_PRESETS in mcp-servers.tsx);
 * the backend `mcp.envKey` only tells session-manager which env var to inject the
 * access token as. We forward our access token to Google's hosted MCP at
 * https://gmailmcp.googleapis.com/mcp/v1 — no second OAuth flow inside the container.
 */
export const config: ProviderConfig = {
	name: 'gmail',
	displayName: 'Gmail',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: [
				'https://www.googleapis.com/auth/gmail.modify',
				'https://www.googleapis.com/auth/gmail.compose',
				'https://www.googleapis.com/auth/userinfo.email',
				'openid',
			],
			pkce: true,
			// access_type=offline + prompt=consent are the documented way to force Google
			// to issue a refresh_token. Without them, only the first connection gets one.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GMAIL_CLIENT_ID',
			clientSecretEnv: 'GMAIL_CLIENT_SECRET',
		},
	},

	webhook: { type: 'custom' },

	events: {
		definitions: [
			{
				entityType: 'gmail.message',
				actions: ['received', 'sent', 'labeled', 'unlabeled', 'trashed', 'untrashed'],
				label: 'Message',
			},
			{ entityType: 'gmail.thread', actions: ['updated'], label: 'Thread' },
		],
	},

	mcp: {
		// Hosted HTTP MCP — frontend preset uses { type: 'http' } directly.
		// These stdio fields are unused at runtime for HTTP MCPs but kept for the
		// envKey lookup in session-manager and for symmetry with other providers.
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://gmailmcp.googleapis.com/mcp/v1'],
		envKey: 'GMAIL_TOKEN',
	},
}
