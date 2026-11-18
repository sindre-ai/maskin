import type { ProviderConfig } from '../../types'

/**
 * YouTube integration via standard OAuth2 (bet "YouTube integration", tech spec rev 5).
 *
 * Read-only, own channel. The Maskin-hosted tool server (maskin-youtube) lives at
 * `${MASKIN_API_URL}/api/integrations/youtube/mcp`; `autoInject: false` matches Meet so each
 * agent opts in on its Tools tab.
 *
 * Differences from the Google Meet auth block, all deliberate:
 *  - `revokeUrl` is set. OAuth2Handler.revokeToken returns silently without it, so the
 *    disconnect hook would do nothing and show no error.
 *  - `include_granted_scopes` is absent. The token then carries only YouTube scopes, and a
 *    revoke does not drag the person's other Google scopes with it.
 *  - Scopes are exactly youtube.readonly, userinfo.email and openid (policy item P5: request
 *    the minimum, and no yt-analytics.readonly until the analytics tool is built).
 *
 * No webhook, postInstall or watch hooks: reads are on demand.
 */
export const config: ProviderConfig = {
	name: 'youtube',
	displayName: 'YouTube',
	description: 'Read your own YouTube channel: channel details and statistics, on demand.',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: [
				'https://www.googleapis.com/auth/youtube.readonly',
				'https://www.googleapis.com/auth/userinfo.email',
				'openid',
			],
			pkce: true,
			// access_type=offline + prompt=consent force Google to issue a refresh_token.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
			},
			clientIdEnv: 'GOOGLE_YOUTUBE_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_YOUTUBE_CLIENT_SECRET',
		},
	},

	mcp: {
		envKey: 'YOUTUBE_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/youtube/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},

	externalIdDisplay: 'email',
}
