import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	config,
	parseTokenResponse,
	resolveExternalId,
	slackExtractDeliveryId,
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

	// AC-T8: code-side scope alignment. The Marketplace listing is built from
	// this array by a separate human follow-up; assert here that everything the
	// tool surface depends on is actually requested.
	//
	// The history scopes were deliberately EXCLUDED in phase 1 (the bot was to
	// see only what it was @mentioned in) and this test asserted their absence.
	// That decision was reversed: agents need to read channel history, so they
	// are now required here and the Marketplace listing was re-submitted to
	// match. The AC-T8 rule is unchanged and runs both ways — this array and the
	// listing move together.
	it('requests every scope the tool surface depends on, including channel history', () => {
		if (config.auth.type !== 'oauth2') throw new Error('unreachable')
		const scopes = new Set(config.auth.config.scopes)
		for (const required of [
			'app_mentions:read',
			'chat:write',
			'chat:write.customize',
			'commands',
			'files:read',
			'im:history',
			'im:write',
			'links:read',
			'links:write',
			'team:read',
			'users:read',
			// Reversed from phase 1 — `slack_read_channel` / `slack_read_thread`
			// cannot work without these.
			'channels:history',
			'groups:history',
			'mpim:history',
			// `slack_read_user_profile` detail and the canvas trio.
			'users.profile:read',
			'canvases:read',
			'canvases:write',
			// `conversations.join`, so a public-channel read can clear its own
			// `not_in_channel` instead of asking a human to invite the bot.
			'channels:join',
		]) {
			expect(scopes.has(required)).toBe(true)
		}
	})

	// `search.messages` has no bot-scope equivalent, so the install asks for a
	// user token in the same round-trip. `extraAuthParams` is applied verbatim to
	// the authorize URL, which is what makes this work with no handler change.
	it('requests the search user scope via extraAuthParams', () => {
		if (config.auth.type !== 'oauth2') throw new Error('unreachable')
		// Present at all: without it Slack returns no user token and the two
		// search tools never register.
		expect(config.auth.config.extraAuthParams?.user_scope).toBeTruthy()
	})

	it('does not request search:read as a bot scope — Slack does not offer one', () => {
		if (config.auth.type !== 'oauth2') throw new Error('unreachable')
		expect(config.auth.config.scopes).not.toContain('search:read')
	})

	// Slack split the blanket `search:read` into per-surface scopes. Asking for
	// the old name would fail the whole authorize with `invalid_scope`.
	it('requests the granular search scopes, not the retired blanket one', () => {
		if (config.auth.type !== 'oauth2') throw new Error('unreachable')
		const userScopes = (config.auth.config.extraAuthParams?.user_scope ?? '').split(',')
		expect(userScopes).toContain('search:read.public')
		expect(userScopes).toContain('search:read.private')
		expect(userScopes).not.toContain('search:read')
	})

	// The scope lists in config.ts and the Slack app manifest are two halves of
	// one contract: Slack rejects the ENTIRE authorize with `invalid_scope` if
	// the request names anything the app does not declare. Nothing at runtime
	// catches that — the first symptom is that connecting Slack stops working
	// for everyone — so pin the subset relationship here.
	it('requests only scopes the Slack app manifest declares', () => {
		if (config.auth.type !== 'oauth2') throw new Error('unreachable')

		const manifest = readFileSync(
			resolve(__dirname, '../../../../../../../docs/integrations/slack/manifest.yml'),
			'utf8',
		)

		// The manifest's scope block is a flat YAML list under `bot:` / `user:`.
		// Parsed with a small reader rather than adding a YAML dependency for one
		// assertion; it fails loudly below if the shape ever changes.
		const declared = (key: 'bot' | 'user'): Set<string> => {
			const lines = manifest.split('\n')
			const start = lines.findIndex((l) => l.trim() === `${key}:`)
			if (start === -1) throw new Error(`manifest.yml has no \`${key}:\` scope list`)
			const scopes: string[] = []
			for (const line of lines.slice(start + 1)) {
				const trimmed = line.trim()
				if (trimmed.startsWith('#') || trimmed === '') continue
				if (!trimmed.startsWith('- ')) break // next YAML key — list is done
				scopes.push(trimmed.slice(2).trim())
			}
			if (scopes.length === 0) throw new Error(`manifest.yml \`${key}:\` list parsed as empty`)
			return new Set(scopes)
		}

		const declaredBot = declared('bot')
		for (const scope of config.auth.config.scopes) {
			expect(
				declaredBot.has(scope),
				`bot scope \`${scope}\` is requested in config.ts but not declared in manifest.yml`,
			).toBe(true)
		}

		const declaredUser = declared('user')
		for (const scope of (config.auth.config.extraAuthParams?.user_scope ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)) {
			expect(
				declaredUser.has(scope),
				`user scope \`${scope}\` is requested in config.ts but not declared in manifest.yml`,
			).toBe(true)
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

	it('auto-injects the Maskin-hosted Slack MCP HTTP server', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.envKey).toBe('SLACK_BOT_TOKEN')
		expect(config.mcp?.autoInject).toBe(true)
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
			headers: {
				Authorization: 'Bearer ${MASKIN_API_KEY}',
				'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
			},
		})
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

	// The dual-token grant. `access_token` must stay the BOT token — the xoxb-
	// guards in session-manager and the MCP server key off it, and a user token
	// landing there would make agents post as the human who installed the app.
	it('stashes the user token from authed_user without disturbing the bot token', () => {
		const raw = {
			ok: true,
			access_token: 'xoxb-bot-token',
			scope: 'channels:read,channels:history',
			team: { id: 'T456TEAM', name: 'Test Workspace' },
			authed_user: {
				id: 'U000USER',
				access_token: 'xoxp-user-token',
				scope: 'search:read',
				token_type: 'user',
			},
		}

		const result = parseTokenResponse(raw)
		expect(result.accessToken).toBe('xoxb-bot-token')
		expect(result.userAccessToken).toBe('xoxp-user-token')
		expect(result.userScope).toBe('search:read')
		expect(result.authedUserId).toBe('U000USER')
	})

	// An install that predates the user_scope grant: Slack still sends
	// `authed_user`, but with an id only and no token.
	it('leaves the user token undefined when authed_user carries no access_token', () => {
		const raw = {
			ok: true,
			access_token: 'xoxb-bot-token',
			authed_user: { id: 'U000USER' },
		}

		const result = parseTokenResponse(raw)
		expect(result.accessToken).toBe('xoxb-bot-token')
		expect(result.authedUserId).toBe('U000USER')
		expect(result.userAccessToken).toBeUndefined()
		expect(result.userScope).toBeUndefined()
	})

	it('throws on error response', () => {
		const raw = { ok: false, error: 'invalid_code' }
		expect(() => parseTokenResponse(raw)).toThrow('Slack token exchange failed: invalid_code')
	})
})

describe('resolveExternalId', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns teamId from credentials when available', async () => {
		const credentials = { accessToken: 'xoxb-test', teamId: 'T123' }
		const id = await resolveExternalId(credentials)
		expect(id).toBe('T123')
	})

	it('calls auth.test API when teamId is missing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () => Promise.resolve({ ok: true, team_id: 'T456' }),
		} as Response)

		const credentials = { accessToken: 'xoxb-test' }
		const id = await resolveExternalId(credentials)

		expect(id).toBe('T456')
		expect(globalThis.fetch).toHaveBeenCalledWith('https://slack.com/api/auth.test', {
			headers: { Authorization: 'Bearer xoxb-test' },
		})
	})

	it('throws when auth.test API returns error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
		} as Response)

		const credentials = { accessToken: 'xoxb-bad-token' }
		await expect(resolveExternalId(credentials)).rejects.toThrow(
			'Failed to resolve Slack team ID: invalid_auth',
		)
	})
})

describe('slackWebhookPreHandler', () => {
	it('returns challenge response for url_verification', () => {
		const payload = { type: 'url_verification', challenge: 'abc123xyz' }
		const response = slackWebhookPreHandler(payload, {})

		expect(response).not.toBeNull()
		expect(response?.body).toEqual({ challenge: 'abc123xyz' })
	})

	it('includes correct challenge in response body', () => {
		const payload = { type: 'url_verification', challenge: 'test-challenge-string' }
		const response = slackWebhookPreHandler(payload, {})

		expect(response).toEqual({ body: { challenge: 'test-challenge-string' } })
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

	it('returns null on retry headers — dedup happens via slackExtractDeliveryId, not a blanket drop', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event_id: 'Ev08RETRY',
			event: { type: 'message' },
		}
		const response = slackWebhookPreHandler(payload, {
			'x-slack-retry-num': '1',
			'x-slack-retry-reason': 'http_timeout',
		})
		expect(response).toBeNull()
	})
})

describe('slackExtractDeliveryId', () => {
	it('returns event_id from event_callback envelope', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event_id: 'Ev08ABC123',
			event: { type: 'message' },
		}
		expect(slackExtractDeliveryId(payload, {})).toBe('Ev08ABC123')
	})

	it('returns the same id across retries so the dedup table can short-circuit them', () => {
		const payload = {
			type: 'event_callback',
			team_id: 'T123',
			event_id: 'Ev08SAME',
			event: { type: 'message' },
		}
		const first = slackExtractDeliveryId(payload, {})
		const retry = slackExtractDeliveryId(payload, {
			'x-slack-retry-num': '2',
			'x-slack-retry-reason': 'http_timeout',
		})
		expect(first).toBe('Ev08SAME')
		expect(retry).toBe('Ev08SAME')
	})

	it('returns null for non-event_callback payloads', () => {
		expect(slackExtractDeliveryId({ type: 'url_verification', challenge: 'abc' }, {})).toBeNull()
	})

	it('returns null when event_id is missing', () => {
		const payload = { type: 'event_callback', team_id: 'T123', event: { type: 'message' } }
		expect(slackExtractDeliveryId(payload, {})).toBeNull()
	})

	it('returns null for malformed payloads', () => {
		expect(slackExtractDeliveryId({}, {})).toBeNull()
		expect(slackExtractDeliveryId(null, {})).toBeNull()
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
			entityType: 'slack.channel_message',
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
