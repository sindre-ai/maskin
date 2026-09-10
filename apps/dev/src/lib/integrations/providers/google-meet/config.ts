import type { ProviderConfig } from '../../types'

/**
 * Google Meet integration — minimal registration surface sufficient for the
 * write-path MCP tools (bet 947e · task 824f) to resolve the token via
 * `TokenManager.getValidToken(...)`.
 *
 * This stub carries the OAuth client env-var names + the Meet scope set so a
 * workspace that has completed the connect flow (Task 2's responsibility) can
 * refresh access tokens against the correct client. Task 2's PR will replace
 * this file with the full config carrying the People-id resolver, webhook
 * hooks, and postInstall — the two writes converge on the same `name:
 * 'google-meet'` registry entry, so a merge is straightforward.
 *
 * `directory.readonly` is deliberately absent per the CTO deliverability read
 * (2026-09-10) — internal-domain email resolution is deferred; external
 * attendees fall through to display-name at v1.
 */
export const config: ProviderConfig = {
	name: 'google-meet',
	displayName: 'Google Meet',
	description:
		'Meet-native tools for post-call recap, attendee capture, transcript access, and programmatic scheduling.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: [
				'openid',
				'https://www.googleapis.com/auth/userinfo.email',
				'https://www.googleapis.com/auth/meetings.space.readonly',
				'https://www.googleapis.com/auth/meetings.space.created',
				'https://www.googleapis.com/auth/calendar.events',
			],
			pkce: true,
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_MEET_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_MEET_CLIENT_SECRET',
		},
	},

	mcp: {
		envKey: 'GOOGLE_MEET_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/google-meet/mcp',
			headers: { Authorization: 'Bearer ${GOOGLE_MEET_TOKEN}' },
		},
	},

	externalIdDisplay: 'email',
}
