import { describe, expect, it } from 'vitest'
import { encodeClientState } from '../../../lib/integrations/providers/telnyx/client'
import {
	classifyHangup,
	clientStateOf,
	parseTelnyxWebhook,
} from '../../../lib/integrations/providers/telnyx/events'

const clientState = {
	contact_id: '11111111-1111-4111-8111-111111111111',
	workspace_id: '22222222-2222-4222-8222-222222222222',
	dial_attempt_n: 2,
}

const envelope = (event_type: string, payload: Record<string, unknown>, id = 'evt_1') => ({
	data: { id, event_type, occurred_at: '2026-10-03T10:00:00Z', payload },
})

describe('parseTelnyxWebhook', () => {
	const common = { call_control_id: 'cc_1', client_state: encodeClientState(clientState) }

	it.each([
		['call.initiated', {}],
		['call.answered', {}],
		['call.hangup', { hangup_cause: 'normal_clearing', duration_s: 12 }],
		['call.machine.premium.detection.ended', { result: 'machine' }],
		['transcription.final', { transcript: 'hej' }],
		[
			'assistant.tool_invocation',
			{ tool_name: 'book_meeting_slot', tool_input: { prospect_email: 'a@b.dk' } },
		],
		['call.transfer.completed', { target: '+4512345678' }],
		['call.transfer.failed', { target: '+4512345678' }],
	])('parses %s', (type, extra) => {
		const out = parseTelnyxWebhook(envelope(type, { ...common, ...extra }))
		expect(out.kind).toBe('known')
		if (out.kind === 'known') {
			expect(out.event.event_type).toBe(type)
			expect(out.event.event_id).toBe('evt_1')
		}
	})

	it('treats an unknown event type as unknown, not invalid', () => {
		expect(parseTelnyxWebhook(envelope('call.speak.ended', common))).toEqual({
			kind: 'unknown',
			eventId: 'evt_1',
			eventType: 'call.speak.ended',
		})
	})

	it('flags a known type with a malformed payload as invalid', () => {
		const out = parseTelnyxWebhook(envelope('call.machine.premium.detection.ended', common))
		expect(out.kind).toBe('invalid')
	})

	it('flags a body that is not a Telnyx envelope as invalid', () => {
		expect(parseTelnyxWebhook({ hello: 'world' }).kind).toBe('invalid')
		expect(parseTelnyxWebhook(null).kind).toBe('invalid')
	})

	it('recovers the dialer client_state from the event', () => {
		const out = parseTelnyxWebhook(envelope('call.answered', common))
		if (out.kind !== 'known') throw new Error('expected known')
		expect(clientStateOf(out.event)).toEqual(clientState)
	})

	it('returns null client_state when absent or not ours', () => {
		const absent = parseTelnyxWebhook(envelope('call.answered', { call_control_id: 'cc_1' }))
		const junk = parseTelnyxWebhook(
			envelope('call.answered', { call_control_id: 'cc_1', client_state: 'bm9wZQ==' }),
		)
		if (absent.kind !== 'known' || junk.kind !== 'known') throw new Error('expected known')
		expect(clientStateOf(absent.event)).toBeNull()
		expect(clientStateOf(junk.event)).toBeNull()
	})
})

describe('classifyHangup', () => {
	it.each([
		['normal_clearing', 'normal'],
		['NORMAL_CLEARING', 'normal'],
		['no_answer', 'no_answer'],
		['timeout', 'no_answer'],
		['busy', 'busy'],
		['user_busy', 'busy'],
		['machine_detected', 'machine_detected'],
		['call_rejected', 'failed'],
		[undefined, 'failed'],
	])('%s -> %s', (cause, kind) => {
		expect(classifyHangup(cause as string | undefined)).toBe(kind)
	})
})
