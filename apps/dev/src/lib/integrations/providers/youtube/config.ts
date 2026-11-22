import type { ProviderConfig } from '../../types'

const READ_SCOPES = [
	'https://www.googleapis.com/auth/youtube.readonly',
	'https://www.googleapis.com/auth/yt-analytics.readonly',
	'https://www.googleapis.com/auth/userinfo.email',
	'openid',
]

const WRITE_SCOPES = [
	'https://www.googleapis.com/auth/youtube.force-ssl',
	'https://www.googleapis.com/auth/youtube',
	'https://www.googleapis.com/auth/youtube.upload',
]

/** Read only unless YOUTUBE_WRITE_SCOPES_ENABLED is "true" (default off). */
export function youtubeScopes(env: Record<string, string | undefined> = process.env): string[] {
	if (env.YOUTUBE_WRITE_SCOPES_ENABLED !== 'true') return [...READ_SCOPES]
	return [...READ_SCOPES.slice(0, 2), ...WRITE_SCOPES, ...READ_SCOPES.slice(2)]
}

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
 *  - Scopes (policy item P5: request the minimum). A new connection asks for read only:
 *    youtube.readonly, yt-analytics.readonly (user activity metrics for youtube__get_analytics, no
 *    revenue), userinfo.email and openid. Google's first verification round covers read
 *    only, so the write scopes are added only when YOUTUBE_WRITE_SCOPES_ENABLED is "true"
 *    (default off). With it on, a connection also asks for youtube.force-ssl and youtube (the
 *    write tools: comments, playlists and video edits need force-ssl; videos.rate and
 *    thumbnails.set need youtube) and youtube.upload (uploads, always private, a second approval
 *    to publish). Writes only run after a person approves. A connection made without them must
 *    reconnect once the setting is on, and an approved write on a read-only connection ends as
 *    failed with Google's http_403 code.
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
			scopes: youtubeScopes(),
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
