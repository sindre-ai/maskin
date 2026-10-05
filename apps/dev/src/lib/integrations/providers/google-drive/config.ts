import type { ProviderConfig } from '../../types'

/**
 * Google Drive integration via standard OAuth2, workspace-scoped (one row per
 * workspace + connected Google account, actor_id NULL), own OAuth client in the
 * shared GCP project. Mirrors google-meet/config.ts.
 *
 * Scope: the single `drive` scope (approved call 1) covers every Drive JTBD with
 * one consent screen. `drive.file` and `drive.readonly` are deliberately NOT
 * requested at v1. `drive` is a Google-restricted scope, so verification is
 * unverified-first for internal + friendly-domain connects.
 *
 * MCP is Maskin-hosted (like Meet): the tools are served from
 * `${MASKIN_API_URL}/api/integrations/google-drive/mcp` and authenticate on the
 * Maskin API key, so the Google token never enters the agent container.
 * `autoInject: false` means each agent opts in explicitly (approved call 9).
 *
 * `events` are the Drive change surface the folder-watch sibling task fans out
 * to; nothing emits them yet.
 */
export const config: ProviderConfig = {
	name: 'google-drive',
	displayName: 'Google Drive',
	description:
		'Drive-native tools for file bytes, structured Doc + Sheet read, search, folder walk + watch, file write, and Doc comments.',
	logoUrl: '/integrations/google-drive.svg',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: [
				'openid',
				'https://www.googleapis.com/auth/userinfo.email',
				'https://www.googleapis.com/auth/drive',
			],
			pkce: true,
			// access_type=offline + prompt=consent force Google to issue a
			// refresh_token on every connect, not only the first for a (user, client).
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_DRIVE_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_DRIVE_CLIENT_SECRET',
		},
	},

	// Drive pushes over HTTPS channels (X-Goog-Channel-* headers). The verifier,
	// pre-handler and fan-out are safe no-op stubs until the folder-watch task.
	webhook: { type: 'custom' },

	events: {
		definitions: [
			{
				entityType: 'google_drive.file',
				actions: ['created', 'updated', 'deleted', 'trashed'],
				label: 'File',
			},
		],
	},

	mcp: {
		envKey: 'GOOGLE_DRIVE_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/google-drive/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},

	externalIdDisplay: 'email',
}
