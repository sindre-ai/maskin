import type { ProviderConfig } from '../../types'

/**
 * COMPILE-CARRY STUB — Task 2 territory
 *
 * The full google-meet provider config (OAuth client, scopes, People-id
 * resolution at callback, frontend surfacing) ships in Task 2's PR
 * (feat/task-ba9d-register-google-meet-provider). This stub exists only so
 * this PR's read-path + async-ingest wiring compiles cleanly against the
 * registry while Task 2 is under review in parallel.
 *
 * When Task 2 merges into the bet branch, the aggregate-review pass replaces
 * this stub with Task 2's canonical config.
 */
export const config: ProviderConfig = {
	name: 'google-meet',
	displayName: 'Google Meet',
	description:
		'Meet-native tools for post-call recap, attendee capture, transcript access, and programmatic scheduling.',
	logoUrl: '/integrations/google-meet.svg',
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
	webhook: { type: 'custom' },
	events: {
		definitions: [
			{
				entityType: 'google_meet.conference',
				actions: ['ended'],
				label: 'Meet conference',
			},
			{
				entityType: 'google_meet.transcript',
				actions: ['ready'],
				label: 'Meet transcript',
			},
			{
				entityType: 'google_meet.recording',
				actions: ['ready'],
				label: 'Meet recording',
			},
		],
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
