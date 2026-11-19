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
 *  - The connect request asks for YOUTUBE_READ_SCOPES only: youtube.readonly, userinfo.email and
 *    openid (policy item P5: request the minimum, and no yt-analytics.readonly until the analytics
 *    tool is built). Only read passed Google's round 1 verification, and unverified scopes on the
 *    production connect screen can show Google's warning.
 *  - YOUTUBE_WRITE_SCOPES (youtube.force-ssl, youtube, youtube.upload) stay out of the request until
 *    round 2 passes. The write and upload tools are built but stay off for every agent. To switch
 *    them on, add YOUTUBE_WRITE_SCOPES to `scopes` below and update the scope test. A connection
 *    made before then must reconnect before an approved change can run.
 *
 * No webhook, postInstall or watch hooks: reads are on demand.
 */
/** Verified in round 1. The only scopes a new connection asks for. */
export const YOUTUBE_READ_SCOPES = [
	'https://www.googleapis.com/auth/youtube.readonly',
	'https://www.googleapis.com/auth/userinfo.email',
	'openid',
]

/**
 * Not requested yet: they wait for Google's round 2 verification. force-ssl is for comments,
 * playlists and video edits, youtube is for videos.rate and thumbnails.set, upload is for private
 * uploads.
 */
export const YOUTUBE_WRITE_SCOPES = [
	'https://www.googleapis.com/auth/youtube.force-ssl',
	'https://www.googleapis.com/auth/youtube',
	'https://www.googleapis.com/auth/youtube.upload',
]

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
			scopes: YOUTUBE_READ_SCOPES,
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
