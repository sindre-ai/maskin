import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/events/record-event', () => ({ recordEvent: vi.fn() }))

import { recordEvent } from '../../../lib/events/record-event'
import { type EffectContext, createDefaultEffectRunner } from '../../../lib/outreach/voice/effects'

const ctx: EffectContext = {
	workspaceId: '00000000-0000-4000-8000-000000000001',
	contactId: '00000000-0000-4000-8000-000000000002',
	actorId: '00000000-0000-4000-8000-000000000003',
	dialAttemptN: 2,
}
const db = {} as Database

describe('voice dead letter posts to #sales', () => {
	const savedEnv = { ...process.env }

	beforeEach(() => {
		process.env.TELNYX_API_KEY = 'test-key'
		process.env.VOICE_SMS_MISSED_CALL_NUDGE = 'hello'
		vi.spyOn(Math, 'random').mockReturnValue(0)
		vi.mocked(recordEvent).mockReset()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		process.env = { ...savedEnv }
	})

	it('posts exactly once, with contact id, dial attempt and reason, after a final 5xx', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
		vi.stubGlobal('fetch', fetchMock)
		const post = vi.fn().mockResolvedValue(undefined)

		await expect(
			createDefaultEffectRunner(db, post).sendSms(
				'missed_call_nudge',
				ctx,
				'+4512345678',
				'+4593707030',
			),
		).rejects.toMatchObject({ name: 'TelnyxHttpError', status: 503 })

		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(post).toHaveBeenCalledTimes(1)
		const text = post.mock.calls[0]?.[0] as string
		expect(text).toContain(ctx.contactId)
		expect(text).toContain('dial attempt 2')
		expect(text).toContain('HTTP 503')
		// The attention-5 event stays.
		expect(recordEvent).toHaveBeenCalledTimes(1)
		expect(recordEvent).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				action: 'voice_dead_letter',
				data: expect.objectContaining({ attention: 5, channel: '#sales' }),
			}),
		)
	})

	it('posts zero times for a 4xx, which surfaces immediately', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 422 }))
		vi.stubGlobal('fetch', fetchMock)
		const post = vi.fn().mockResolvedValue(undefined)

		await expect(
			createDefaultEffectRunner(db, post).sendSms(
				'missed_call_nudge',
				ctx,
				'+4512345678',
				'+4593707030',
			),
		).rejects.toMatchObject({ name: 'TelnyxHttpError', status: 422 })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(post).not.toHaveBeenCalled()
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('posts once for a reducer dead letter effect, carrying its reason', async () => {
		const post = vi.fn().mockResolvedValue(undefined)

		await createDefaultEffectRunner(db, post).deadLetter('stale_dialing_claim', ctx)

		expect(post).toHaveBeenCalledTimes(1)
		expect(post.mock.calls[0]?.[0]).toContain('stale_dialing_claim')
		expect(recordEvent).toHaveBeenCalledTimes(1)
	})
})
