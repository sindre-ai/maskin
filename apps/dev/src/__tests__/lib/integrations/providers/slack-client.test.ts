import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	_resetSlackCaches,
	joinSlackChannel,
	listSlackConversations,
} from '../../../../lib/integrations/providers/slack/client'

describe('listSlackConversations — is_member mapping', () => {
	beforeEach(() => {
		_resetSlackCaches()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('carries the is_member flag through the mapper for public and private channels', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () =>
				Promise.resolve({
					ok: true,
					channels: [
						{
							id: 'C_MEMBER',
							name: 'general',
							is_channel: true,
							is_private: false,
							is_member: true,
						},
						{
							id: 'C_NON_MEMBER',
							name: 'stray',
							is_channel: true,
							is_private: false,
							is_member: false,
						},
						{
							id: 'G_PRIVATE_MEMBER',
							name: 'planning',
							is_channel: true,
							is_private: true,
							is_member: true,
						},
					],
					response_metadata: {},
				}),
		} as unknown as Response)

		const conversations = await listSlackConversations('integration-1', 'xoxb-token', [
			'public_channel',
			'private_channel',
		])

		const byId = new Map(conversations.map((c) => [c.id, c]))
		expect(byId.get('C_MEMBER')?.is_member).toBe(true)
		expect(byId.get('C_NON_MEMBER')?.is_member).toBe(false)
		expect(byId.get('G_PRIVATE_MEMBER')?.is_member).toBe(true)
	})

	it('defaults is_member to true for DMs and MPIMs even when Slack omits the field', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () =>
				Promise.resolve({
					ok: true,
					channels: [
						// DM — Slack does not send is_member; presence in the response
						// implies the bot is a participant.
						{ id: 'D_1', name: '', is_im: true },
						// MPIM — same idea.
						{ id: 'M_1', name: 'mpdm-alice--bob-1', is_mpim: true },
					],
					response_metadata: {},
				}),
		} as unknown as Response)

		const conversations = await listSlackConversations('integration-2', 'xoxb-token', [
			'im',
			'mpim',
		])

		const byId = new Map(conversations.map((c) => [c.id, c]))
		expect(byId.get('D_1')?.is_member).toBe(true)
		expect(byId.get('M_1')?.is_member).toBe(true)
	})
})

// Transport-level tests for `joinSlackChannel`. Status classification
// (mapping `is_private` → `'not_public'`, etc.) lives in the setup service
// and is covered by `slack-trigger-setup.test.ts` — here we assert only what
// this helper is responsible for: the exact request shape and the
// `SlackJoinResult` discriminated union it returns.

describe('joinSlackChannel', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function respond(body: Record<string, unknown>) {
		fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body } as Response)
	}

	it('POSTs conversations.join with the channel id and reports success', async () => {
		respond({ ok: true })

		const result = await joinSlackChannel('xoxb-test', 'C075JBZ65RT')

		expect(result).toEqual({ ok: true, already_in: false })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://slack.com/api/conversations.join')
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body as string)).toEqual({ channel: 'C075JBZ65RT' })
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test')
	})

	// Slack signals a repeat join as a *warning* riding along with an ordinary
	// ok:true channel payload — never as a top-level `already_in_channel`
	// boolean. It populates the scalar `warning` and the
	// `response_metadata.warnings` array inconsistently, so both are covered.
	// The service treats `already_in` as idempotent success so a re-run is safe
	// (spec §2 idempotency).
	it('reads already_in from the scalar warning field', async () => {
		respond({ ok: true, channel: { id: 'C0GENERAL01' }, warning: 'already_in_channel' })

		const result = await joinSlackChannel('xoxb-test', 'C0GENERAL01')

		expect(result).toEqual({ ok: true, already_in: true })
	})

	it('reads already_in from response_metadata.warnings', async () => {
		respond({
			ok: true,
			channel: { id: 'C0GENERAL01' },
			response_metadata: { warnings: ['already_in_channel'] },
		})

		const result = await joinSlackChannel('xoxb-test', 'C0GENERAL01')

		expect(result).toEqual({ ok: true, already_in: true })
	})

	// Regression: the original implementation read a top-level
	// `already_in_channel` boolean, which Slack does not send. Against the real
	// API that yielded already_in:false on every re-join, so the persisted status
	// and the PostHog outcome could never report `already_in`.
	it('does not treat a top-level already_in_channel field as the signal', async () => {
		respond({ ok: true, channel: { id: 'C0GENERAL01' }, already_in_channel: true })

		const result = await joinSlackChannel('xoxb-test', 'C0GENERAL01')

		expect(result).toEqual({ ok: true, already_in: false })
	})

	it('surfaces the is_private error verbatim so the service can classify it', async () => {
		respond({ ok: false, error: 'is_private' })

		const result = await joinSlackChannel('xoxb-test', 'C0PRIVATE01')

		expect(result).toEqual({ ok: false, error: 'is_private' })
	})

	it('passes through not_authed so the caller can map it to the reconnect banner', async () => {
		respond({ ok: false, error: 'not_authed' })

		const result = await joinSlackChannel('xoxb-revoked', 'C075JBZ65RT')

		expect(result).toEqual({ ok: false, error: 'not_authed' })
	})

	it('passes through channel_not_found for archived / renamed channels', async () => {
		respond({ ok: false, error: 'channel_not_found' })

		const result = await joinSlackChannel('xoxb-test', 'C0GONE0000')

		expect(result).toEqual({ ok: false, error: 'channel_not_found' })
	})
})
