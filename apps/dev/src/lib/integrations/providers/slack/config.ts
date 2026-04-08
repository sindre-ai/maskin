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

	mcp: {
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-slack'],
		envKey: 'SLACK_BOT_TOKEN',
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
 * Slack sends this once when the Events API URL is configured.
 * Must respond with the challenge string to complete the handshake.
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
