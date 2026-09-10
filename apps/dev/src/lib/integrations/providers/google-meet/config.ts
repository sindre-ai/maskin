import type { ProviderConfig } from '../../types'

/**
 * Google Meet integration via standard OAuth2.
 *
 * Ingest is push-only, via a Google Workspace Events subscription that pushes
 * to a shared Pub/Sub topic (Gmail-verbatim) — Task 3 wires the subscription
 * setup, webhook verifier, and fan-out. Here we only stand the provider up so
 * it appears in `GET /api/integrations/providers`, its own OAuth client is
 * exercised, and the callback can persist a Meet integration row.
 *
 * Scope choices (per bet lock-down, Reshape §1):
 *  - `openid` + `userinfo.email` — `resolveGoogleEmail` (external_id) and
 *    `people.get(me)` (People-id fetch at callback) both ride these two.
 *  - `meetings.space.readonly` — read conferenceRecords / transcripts /
 *    participants / recordings; JTBDs #1–#3 + #5.
 *  - `meetings.space.created` — create Meet spaces via
 *    `google_meet__create_space` (Task 4). JTBD #4.
 *
 * `directory.readonly` is deliberately ABSENT (CTO 2026-09-10). Adding it
 * would gain internal-domain email resolution only (external attendees fall
 * through to `display_name` regardless) at the cost of extra consent friction
 * on every customer connect and heavier Google verification scrutiny. Revisit
 * as a follow-on if adoption data justifies re-taking the scope-cost hit.
 *
 * MCP is Maskin-hosted (mirrors the Slack v2 pattern, ADR-007), NOT Google's
 * hosted MCP — the seven `google_meet__*` tools ship in Task 4 under
 * `${MASKIN_API_URL}/api/integrations/google-meet/mcp`. `autoInject: false`
 * matches Gmail / GCal so each agent opts in via its Tools tab.
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
			// access_type=offline + prompt=consent are the documented way to force
			// Google to issue a refresh_token. Without them only the first connect
			// for a given (user, client) pair gets one.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_MEET_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_MEET_CLIENT_SECRET',
		},
	},

	// Push via Google Workspace Events → Pub/Sub. Custom OIDC JWT verification
	// ships in Task 3's webhooks.ts (mirrors gmailWebhookVerifier).
	webhook: { type: 'custom' },

	// Event surface Task 3 fans out from the Workspace Events push. Kept as
	// state-of-the-world definitions here so the provider metadata renders on
	// day one — trigger UIs (`apps/web/src/components/triggers/**`) read this
	// list from `GET /api/integrations/providers`. Task 3 wires the normalizer
	// that emits these entity/action pairs from real Pub/Sub deliveries.
	events: {
		definitions: [
			{ entityType: 'meet.conference', actions: ['ended'], label: 'Conference' },
			{ entityType: 'meet.transcript', actions: ['ready'], label: 'Transcript' },
			{ entityType: 'meet.recording', actions: ['ready'], label: 'Recording' },
		],
	},

	mcp: {
		envKey: 'GOOGLE_MEET_TOKEN',
		autoInject: false,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/google-meet/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},

	externalIdDisplay: 'email',
}
