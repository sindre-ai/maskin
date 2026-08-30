import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { joinSlackChannel } from '../../../../lib/integrations/providers/slack/client'

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

	it('collapses already_in_channel:true to a successful already_in result', async () => {
		respond({ ok: true, already_in_channel: true })

		const result = await joinSlackChannel('xoxb-test', 'C0GENERAL01')

		// The service treats `already_in` as idempotent success so a re-run is
		// safe (spec §2 idempotency).
		expect(result).toEqual({ ok: true, already_in: true })
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
