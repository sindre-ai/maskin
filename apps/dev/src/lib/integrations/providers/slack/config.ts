import type { ProviderConfig, StoredCredentials } from '../../types'

export const config: ProviderConfig = {
	name: 'slack',
	displayName: 'Slack',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://slack.com/oauth/v2/authorize',
			tokenUrl: 'https://slack.com/api/oauth.v2.access',
			scopes: [
				'channels:read',
				'channels:history',
				'channels:join',
				'groups:read',
				'groups:history',
				'im:read',
				'im:history',
				'im:write',
				'mpim:read',
				'mpim:history',
				'chat:write',
				'chat:write.customize',
				'users:read',
				'app_mentions:read',
				'reactions:read',
				'reactions:write',
			],
			clientIdEnv: 'SLACK_CLIENT_ID',
			clientSecretEnv: 'SLACK_CLIENT_SECRET',
		},
	},

	webhook: {
		signatureHeader: 'x-slack-signature',
		signatureScheme: 'timestamp',
		secretEnv: 'SLACK_SIGNING_SECRET',
		timestampHeader: 'x-slack-request-timestamp',
		timestampSignatureHeader: 'x-slack-signature',
		timestampBodyTemplate: 'v0:{timestamp}:{body}',
		timestampSignaturePrefix: 'v0=',
	},

	events: {
		definitions: [
			{ entityType: 'slack.message', actions: ['created'], label: 'Message (any)' },
			{ entityType: 'slack.channel_message', actions: ['created'], label: 'Channel Message' },
			{ entityType: 'slack.group_message', actions: ['created'], label: 'Group Message' },
			{ entityType: 'slack.direct_message', actions: ['created'], label: 'Direct Message' },
			{ entityType: 'slack.app_mention', actions: ['created'], label: 'App Mention' },
			{ entityType: 'slack.reaction', actions: ['added', 'removed'], label: 'Reaction' },
			{
				entityType: 'slack.channel',
				actions: ['created', 'deleted', 'renamed'],
				label: 'Channel',
			},
			{ entityType: 'slack.member', actions: ['joined'], label: 'Member' },
		],
	},

	// Auto-inject the Maskin-hosted Slack MCP server for every workspace with an
	// active Slack integration. The HTTP MCP is on apps/dev itself, so requests
	// are bot-token + identity (agent name, workspace name) resolved server-side
	// and posted via chat.postMessage with `chat:write.customize` overrides —
	// replacing @modelcontextprotocol/server-slack, which posted as whoever
	// installed the app. `envKey` is kept so session-manager still injects
	// SLACK_BOT_TOKEN for any agent that has a legacy stdio Slack MCP in their
	// tools config; the xoxb- guard in session-manager refuses to inject when
	// the stored token is a user token.
	mcp: {
		envKey: 'SLACK_BOT_TOKEN',
		autoInject: true,
		server: {
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		},
	},
}

/**
 * Slack returns a non-standard token response:
 * { ok, access_token, token_type, scope, bot_user_id, app_id, team: { id, name }, ... }
 *
 * Tokens never expire — no refresh_token or expires_in.
 * Scopes are comma-separated (not space-separated).
 */
export const parseTokenResponse = (raw: unknown): Partial<StoredCredentials> => {
	const data = raw as Record<string, unknown>
	if (data.ok === false) {
		throw new Error(`Slack token exchange failed: ${(data.error as string) ?? 'unknown error'}`)
	}
	if (typeof data.access_token !== 'string') {
		throw new Error('Slack token response missing access_token')
	}
	const team = data.team as Record<string, unknown> | undefined
	return {
		accessToken: data.access_token,
		tokenType: typeof data.token_type === 'string' ? data.token_type : undefined,
		scope: typeof data.scope === 'string' ? data.scope : undefined,
		teamId: typeof team?.id === 'string' ? team.id : undefined,
		teamName: typeof team?.name === 'string' ? team.name : undefined,
		botUserId: typeof data.bot_user_id === 'string' ? data.bot_user_id : undefined,
		appId: typeof data.app_id === 'string' ? data.app_id : undefined,
	}
}

/**
 * Resolve the Slack team ID for webhook matching.
 * Prefers the teamId stashed by parseTokenResponse, falls back to auth.test API.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	if (credentials.teamId) return credentials.teamId as string

	const res = await fetch('https://slack.com/api/auth.test', {
		headers: { Authorization: `Bearer ${credentials.accessToken}` },
	})
	const data = (await res.json()) as { ok: boolean; team_id?: string; error?: string }
	if (!data.ok || !data.team_id) {
		throw new Error(`Failed to resolve Slack team ID: ${data.error ?? 'unknown error'}`)
	}
	return data.team_id
}

/**
 * Handle Slack's url_verification challenge.
 *
 * Slack sends this once when the Events API URL is configured; we must echo
 * the challenge to complete the handshake. Retries are handled separately via
 * `slackExtractDeliveryId` + the generic `webhook_deliveries` dedup table.
 */
export const slackWebhookPreHandler = (
	payload: unknown,
	_headers: Record<string, string>,
): { body: unknown; status?: number } | null => {
	const data = payload as Record<string, unknown>
	if (data.type === 'url_verification' && typeof data.challenge === 'string') {
		return { body: { challenge: data.challenge } }
	}
	return null
}

/**
 * Slack puts a stable `event_id` (e.g. `Ev08ABC...`) on the outer envelope of
 * every `event_callback` and reuses it across retries. The webhook route uses
 * this to dedupe retries via the `webhook_deliveries` table — preferable to an
 * `x-slack-retry-num` short-circuit because the latter drops every retry,
 * including ones triggered by a genuine prior failure.
 *
 * Semantics: the route claims the dedup row BEFORE doing any work, so this is
 * at-most-once. A crash after the claim but before processing finishes means
 * Slack's retry will be treated as a duplicate and skipped — we accept that
 * tradeoff to guarantee we never reprocess a delivery (which would create
 * duplicate insights and duplicate downloaded files).
 */
export const slackExtractDeliveryId = (
	payload: unknown,
	_headers: Record<string, string>,
): string | null => {
	if (!payload || typeof payload !== 'object') return null
	const data = payload as Record<string, unknown>
	if (data.type !== 'event_callback') return null
	const eventId = data.event_id
	return typeof eventId === 'string' && eventId.length > 0 ? eventId : null
}
