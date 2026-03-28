import { describe, expect, it, vi } from 'vitest'
import {
	config,
	parseTokenResponse,
	resolveExternalId,
	slackWebhookPreHandler,
} from '../../../../lib/integrations/providers/slack/config'
import { slackEventNormalizer } from '../../../../lib/integrations/providers/slack/webhooks'

describe('Slack provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('slack')
		expect(config.displayName).toBe('Slack')
	})

	it('uses standard oauth2 auth type', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://slack.com/oauth/v2/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://slack.com/api/oauth.v2.access')
			expect(config.auth.config.clientIdEnv).toBe('SLACK_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('SLACK_CLIENT_SECRET')
			expect(config.auth.config.scopes).toContain('chat:write')
			expect(config.auth.config.scopes).toContain('channels:read')
			expect(config.auth.config.scopes).toContain('groups:read')
			expect(config.auth.config.scopes).toContain('im:read')
		}
	})

	it('has webhook config with timestamp scheme', () => {
		const wh = config.webhook
		expect(wh).toBeDefined()
		expect(wh).not.toHaveProperty('type')
		if (wh && 'signatureScheme' in wh) {
			expect(wh.signatureScheme).toBe('timestamp')
			expect(wh.secretEnv).toBe('SLACK_SIGNING_SECRET')
			expect(wh.timestampHeader).toBe('x-slack-request-timestamp')
			expect(wh.timestampSignatureHeader).toBe('x-slack-signature')
			expect(wh.timestampBodyTemplate).toBe('v0:{timestamp}:{body}')
			expect(wh.timestampSignaturePrefix).toBe('v0=')
		}
	})

	it('defines event types', () => {
		expect(config.events?.definitions).toBeDefined()
		const types = config.events?.definitions.map((d) => d.entityType)
		expect(types).toContain('slack.message')
		expect(types).toContain('slack.app_mention')
		expect(types).toContain('slack.reaction')
		expect(types).toContain('slack.channel')
		expect(types).toContain('slack.member')
	})
})

describe('parseTokenResponse', () => {
	it('extracts fields from Slack token response', () => {
		const raw = {
			ok: true,
			access_token: 'xoxb-test-token',
			token_type: 'bot',
			scope: 'channels:read,chat:write',
			bot_user_id: 'U123BOT',
			app_id: 'A789APP',
			team: { id: 'T456TEAM', name: 'Test Workspace' },
			authed_user: { id: 'U000USER' },
		}

		const result = parseTokenResponse(raw)
		expect(result.accessToken).toBe('xoxb-test-token')
		expect(result.tokenType).toBe('bot')
		expect(result.scope).toBe('channels:read,chat:write')
		expect(result.teamId).toBe('T456TEAM')
		expect(result.teamName).toBe('Test Workspace')
		expect(result.botUserId).toBe('U123BOT')
		expect(result.appId).toBe('A789APP')
	})

	it('handles missing team gracefully', () => {
		const raw = { ok: true, access_token: 'xoxb-test' }
		const result = parseTokenResponse(raw)
		expect(result.accessToken).toBe('xoxb-test')
		expect(result.teamId).toBeUndefined()
		expect(result.teamName).toBeUndefined()
	})
})

describe('resolveExternalId', () => {
	it('returns teamId from credentials when available', async () => {
		const credentials = { accessToken: 'xoxb-test', teamId: 'T123' }
		const id = await resolveExternalId(credentials)
		expect(id).toBe('T123')
	})

	it('calls auth.test API when teamId is missing', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ ok: true, team_id: 'T456' }),
		})
		vi.stubGlobal('fetch', mockFetch)

		const credentials = { accessToken: 'xoxb-test' }
		const id = await resolveExternalId(credentials)

		expect(id).toBe('T456')
		expect(mockFetch).toHaveBeenCalledWith('https://slack.com/api/auth.test', {
			headers: { Authorization: 'Bearer xoxb-test' },
		})

		vi.unstubAllGlobals()
	})
})

describe('slackWebhookPreHandler', () => {
	it('returns challenge response for url_verification', () => {
		const payload = { type: 'url_verification', challenge: 'abc123xyz' }
		const response = slackWebhookPreHandler(payload, {})

		expect(response).toBeInstanceOf(Response)
		expect(response).not.toBeNull()
	})

	it('includes correct challenge in response body', async () => {
		const payload = { type: 'url_verification', challenge: 'test-challenge-string' }
		const response = slackWebhookPreHandler(payload, {})

		const body = await response?.json()
		expect(body).toEqual({ challenge: 'test-challenge-string' })
	})

	it('returns null for event_callback', () => {
		const payload = { type: 'event_callback', team_id: 'T123', event: { type: 'message' } }
		const response = slackWebhookPreHandler(payload, {})
		expect(response).toBeNull()
	})

	it('returns null when challenge is missing', () => {
		const payload = { type: 'url_verification' }
		const response = slackWebhookPreHandler(payload, {})
		expect(response).toBeNull()
	})
})

describe('slackEventNormalizer', () => {
	it('normalizes message event', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'message', text: 'hello', user: 'U456', channel: 'C789' },
		}
		const result = slackEventNormalizer(payload, {})

		expect(result).toEqual({
			entityType: 'slack.message',
			action: 'created',
			installationId: 'T123',
			data: payload,
		})
	})

	it('normalizes app_mention event', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'app_mention', text: '<@U123> hello', user: 'U456' },
		}
		const result = slackEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.entityType).toBe('slack.app_mention')
		expect(result?.action).toBe('created')
	})

	it('normalizes reaction_added event', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'reaction_added', reaction: 'thumbsup', user: 'U456' },
		}
		const result = slackEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.entityType).toBe('slack.reaction')
		expect(result?.action).toBe('added')
	})

	it('normalizes reaction_removed event', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'reaction_removed', reaction: 'thumbsup', user: 'U456' },
		}
		const result = slackEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.entityType).toBe('slack.reaction')
		expect(result?.action).toBe('removed')
	})

	it('normalizes channel_created event', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'channel_created', channel: { id: 'C123', name: 'new-channel' } },
		}
		const result = slackEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.entityType).toBe('slack.channel')
		expect(result?.action).toBe('created')
	})

	it('normalizes member_joined_channel event', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'member_joined_channel', user: 'U456', channel: 'C789' },
		}
		const result = slackEventNormalizer(payload, {})

		expect(result).not.toBeNull()
		expect(result?.entityType).toBe('slack.member')
		expect(result?.action).toBe('joined')
	})

	it('returns null for url_verification type', () => {
		const payload = { type: 'url_verification', challenge: 'abc123' }
		expect(slackEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null for unknown event types', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event: { type: 'unknown_event_type' },
		}
		expect(slackEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when team_id is missing', () => {
		const payload = {
			type: 'event_callback',
			event: { type: 'message', text: 'hello' },
		}
		expect(slackEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when event object is missing', () => {
		const payload = { type: 'event_callback', team_id: 'T123' }
		expect(slackEventNormalizer(payload, {})).toBeNull()
	})
})
