import { describe, expect, it } from 'vitest'
import {
	type AdvanceResult,
	VOICE_STATUSES,
	type VoiceContact,
	type VoiceEvent,
	advance,
	voiceEventSchema,
} from '../../../lib/outreach/voice/state'

// Thu 2026-10-01 11:00 CEST. Fri is the next workday; the weekend follows.
const NOW = new Date('2026-10-01T09:00:00Z')
const TODAY = '2026-10-01'

function contact(status: string, metadata: Record<string, unknown> = {}): VoiceContact {
	return { status, metadata }
}

/** Applies a result the way apply.ts does, so sequences can be chained. */
function after(c: VoiceContact, r: AdvanceResult): VoiceContact {
	const metadata: Record<string, unknown> = { ...(c.metadata ?? {}) }
	for (const [k, v] of Object.entries(r.metadata)) {
		if (v === null) delete metadata[k]
		else metadata[k] = v
	}
	return { status: r.status, metadata }
}

function run(c: VoiceContact, events: VoiceEvent[], now = NOW): VoiceContact {
	return events.reduce((acc, e) => after(acc, advance(acc, e, now)), c)
}

const initiated = (callId = 'call-1', extra: Partial<VoiceEvent> = {}): VoiceEvent =>
	({
		type: 'call_initiated',
		callId,
		to: '+4511111111',
		from: '+4522222222',
		...extra,
	}) as VoiceEvent
const answered = (callId = 'call-1'): VoiceEvent => ({ type: 'call_answered', callId })
const hangup = (cause: string, callId = 'call-1'): VoiceEvent => ({
	type: 'call_hangup',
	callId,
	cause,
	to: '+4511111111',
	from: '+4522222222',
})
const machine = (callId = 'call-1'): VoiceEvent => ({
	type: 'machine_detection',
	callId,
	result: 'machine',
	to: '+4511111111',
	from: '+4522222222',
})

describe('voice status list', () => {
	it('carries the ten voice_* statuses', () => {
		expect(VOICE_STATUSES).toHaveLength(10)
		expect(new Set(VOICE_STATUSES).size).toBe(10)
	})
})

describe('call_initiated', () => {
	it('sets voice_dialing and stamps attempt number, call id and the dial day', () => {
		const r = advance(contact('voice_queued'), initiated(), NOW)
		expect(r.applied).toBe(true)
		expect(r.status).toBe('voice_dialing')
		expect(r.metadata).toMatchObject({
			dial_attempt_n: 1,
			last_call_id: 'call-1',
			dial_day: TODAY,
			dial_day_attempts: 1,
			amd_result: null,
			next_dial_at: null,
		})
	})

	it('takes the attempt number from the dialer when it sent one', () => {
		const r = advance(
			contact('voice_queued', { dial_attempt_n: 1 }),
			initiated('c', { dialAttemptN: 4 }),
			NOW,
		)
		expect(r.metadata.dial_attempt_n).toBe(4)
	})

	it('otherwise counts one past the previous attempt', () => {
		const r = advance(contact('voice_no_answer', { dial_attempt_n: 2 }), initiated('call-3'), NOW)
		expect(r.metadata.dial_attempt_n).toBe(3)
	})

	it('is a no-op when the same call is replayed', () => {
		const c = contact('voice_answered', { last_call_id: 'call-1', dial_attempt_n: 1 })
		expect(advance(c, initiated('call-1'), NOW).applied).toBe(false)
	})

	it('counts same-day attempts and resets on a new day', () => {
		const sameDay = advance(
			contact('voice_busy', {
				dial_day: TODAY,
				dial_day_attempts: 1,
				dial_attempt_n: 1,
				last_call_id: 'a',
			}),
			initiated('b'),
			NOW,
		)
		expect(sameDay.metadata.dial_day_attempts).toBe(2)
		const newDay = advance(
			contact('voice_busy', {
				dial_day: '2026-09-30',
				dial_day_attempts: 2,
				dial_attempt_n: 2,
				last_call_id: 'a',
			}),
			initiated('b'),
			NOW,
		)
		expect(newDay.metadata.dial_day_attempts).toBe(1)
	})

	it('clears the previous call tool trace', () => {
		const r = advance(
			contact('voice_queued', { voice_tool_trace: [{ tool_name: 'confirm_meeting_slot' }] }),
			initiated(),
			NOW,
		)
		expect(r.metadata.voice_tool_trace).toEqual([])
	})
})

describe('call_answered', () => {
	it('moves voice_dialing to voice_answered', () => {
		const r = advance(contact('voice_dialing', { last_call_id: 'call-1' }), answered(), NOW)
		expect(r.status).toBe('voice_answered')
	})

	it('ignores an event for an older call', () => {
		expect(
			advance(contact('voice_dialing', { last_call_id: 'call-2' }), answered('call-1'), NOW)
				.applied,
		).toBe(false)
	})

	it('does not drag a resolved contact back to voice_answered', () => {
		expect(
			advance(contact('voice_voicemail', { last_call_id: 'call-1' }), answered(), NOW).applied,
		).toBe(false)
		expect(
			advance(contact('voice_meeting_booked', { last_call_id: 'call-1' }), answered(), NOW).applied,
		).toBe(false)
	})
})

describe('machine_detection (AMD)', () => {
	it('human stamps amd_result and does nothing else', () => {
		const c = contact('voice_answered', { last_call_id: 'call-1' })
		const r = advance(c, { type: 'machine_detection', callId: 'call-1', result: 'human' }, NOW)
		expect(r.status).toBe('voice_answered')
		expect(r.metadata).toEqual({ amd_result: 'human' })
		expect(r.effects).toEqual([])
	})

	it('machine forces hangup, sets voicemail, fires the voicemail SMS and requeues +2 workdays', () => {
		const c = contact('voice_answered', { last_call_id: 'call-1', dial_attempt_n: 1 })
		const r = advance(c, machine(), NOW)
		expect(r.status).toBe('voice_voicemail')
		expect(r.effects).toEqual([
			{ type: 'hangup_call', callId: 'call-1' },
			{ type: 'send_sms', mode: 'voicemail_followup', to: '+4511111111', from: '+4522222222' },
		])
		expect(r.metadata).toMatchObject({
			amd_result: 'machine',
			voicemail_n: 1,
			// Thu 11:00 CEST + 2 workdays = Mon 11:00 CEST
			next_dial_at: '2026-10-05T09:00:00.000Z',
		})
	})

	it('a second voicemail exhausts the single retry and fails the contact', () => {
		const c = contact('voice_answered', {
			last_call_id: 'call-2',
			dial_attempt_n: 2,
			voicemail_n: 1,
		})
		const r = advance(c, machine('call-2'), NOW)
		expect(r.status).toBe('voice_failed')
		expect(r.metadata.next_dial_at).toBeNull()
	})

	it('is a no-op when the machine verdict is replayed', () => {
		const c = contact('voice_voicemail', { last_call_id: 'call-1', amd_result: 'machine' })
		expect(advance(c, machine(), NOW).applied).toBe(false)
	})

	it.each(['human_residence', 'human_business', 'HUMAN_RESIDENCE'])(
		'treats premium result %s as human',
		(result) => {
			const c = contact('voice_answered', { last_call_id: 'call-1' })
			const r = advance(c, { type: 'machine_detection', callId: 'call-1', result }, NOW)
			expect(r.status).toBe('voice_answered')
			expect(r.metadata).toEqual({ amd_result: 'human' })
			expect(r.effects).toEqual([])
		},
	)

	it('ignores inconclusive results and stale calls', () => {
		const c = contact('voice_answered', { last_call_id: 'call-1' })
		expect(
			advance(c, { type: 'machine_detection', callId: 'call-1', result: 'not_sure' }, NOW).applied,
		).toBe(false)
		expect(advance(c, machine('call-0'), NOW).applied).toBe(false)
	})

	it('the hangup that follows a machine verdict does not run the voicemail path twice', () => {
		const c = run(contact('voice_queued'), [initiated(), answered(), machine()])
		expect(c.status).toBe('voice_voicemail')
		const r = advance(c, hangup('normal_clearing'), NOW)
		expect(r.applied).toBe(false)
	})
})

describe('absorbing statuses', () => {
	const absorbing = ['voice_declined', 'voice_meeting_booked', 'voice_warm_transferred']

	it.each(absorbing)('%s is not revived by a late call.initiated', (status) => {
		const r = advance(contact(status, { last_call_id: 'call-1' }), initiated('call-2'), NOW)
		expect(r.applied).toBe(false)
		expect(r.status).toBe(status)
		expect(r.metadata).toEqual({})
	})

	it.each(absorbing)('%s ignores every other event too', (status) => {
		const c = contact(status, { last_call_id: 'call-1' })
		const events: VoiceEvent[] = [
			answered(),
			hangup('no_answer'),
			hangup('busy'),
			machine(),
			{ type: 'transfer_completed', callId: 'call-1' },
			{ type: 'rest_failure', reason: 'x' },
		]
		for (const e of events) expect(advance(c, e, NOW).applied).toBe(false)
	})

	it('voice_failed is terminal for retries but a human can requeue and dial again', () => {
		const r = advance(contact('voice_failed', { last_call_id: 'old' }), initiated('call-9'), NOW)
		expect(r.status).toBe('voice_dialing')
	})
})

describe('staleCall flag', () => {
	it('is set for an event naming an older call, and not for the current one', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-2' })
		expect(advance(c, hangup('no_answer', 'call-1'), NOW).staleCall).toBe(true)
		expect(advance(c, hangup('no_answer', 'call-2'), NOW).staleCall).toBe(false)
	})

	it('is false for a hangup the reducer absorbed on the current call', () => {
		const r = advance(
			contact('voice_warm_transferred', { last_call_id: 'call-1' }),
			hangup('normal_clearing'),
			NOW,
		)
		expect(r.applied).toBe(false)
		expect(r.staleCall).toBe(false)
	})
})

describe('call_hangup: connected call (normal_clearing)', () => {
	it('resolves to voice_meeting_booked when the trace contains confirm_meeting_slot', () => {
		const c = contact('voice_answered', {
			last_call_id: 'call-1',
			voice_tool_trace: [
				{ tool_name: 'book_meeting_slot' },
				{ tool_name: 'confirm_meeting_slot' },
				{ tool_name: 'end_call_polite' },
			],
		})
		const r = advance(c, hangup('normal_clearing'), NOW)
		expect(r.status).toBe('voice_meeting_booked')
		expect(r.metadata.next_dial_at).toBeNull()
	})

	it('resolves to voice_declined when nothing was booked', () => {
		const c = contact('voice_answered', {
			last_call_id: 'call-1',
			voice_tool_trace: [{ tool_name: 'end_call_polite' }],
		})
		expect(advance(c, hangup('normal_clearing'), NOW).status).toBe('voice_declined')
	})

	it('resolves to follow_up_later when the prospect asked for the email and nothing was booked', () => {
		const c = contact('voice_answered', {
			last_call_id: 'call-1',
			next_dial_at: '2026-10-02T09:00:00.000Z',
			voice_tool_trace: [{ tool_name: 'request_followup_email' }, { tool_name: 'end_call_polite' }],
		})
		const r = advance(c, hangup('normal_clearing'), NOW)
		expect(r.status).toBe('follow_up_later')
		expect(r.applied).toBe(true)
		expect(r.metadata.next_dial_at).toBeNull()
	})

	it('a booking wins over an email request', () => {
		const c = contact('voice_answered', {
			last_call_id: 'call-1',
			voice_tool_trace: [
				{ tool_name: 'request_followup_email' },
				{ tool_name: 'confirm_meeting_slot' },
			],
		})
		expect(advance(c, hangup('normal_clearing'), NOW).status).toBe('voice_meeting_booked')
	})

	it('leaves a warm transfer alone even when an email was requested', () => {
		const c = contact('voice_warm_transferred', {
			last_call_id: 'call-1',
			voice_tool_trace: [{ tool_name: 'request_followup_email' }],
		})
		expect(advance(c, hangup('normal_clearing'), NOW).applied).toBe(false)
	})

	it('leaves a warm transfer alone', () => {
		const c = contact('voice_warm_transferred', { last_call_id: 'call-1' })
		expect(advance(c, hangup('normal_clearing'), NOW).applied).toBe(false)
	})
})

describe('transfers', () => {
	it('transfer_completed sets voice_warm_transferred', () => {
		const r = advance(
			contact('voice_answered', { last_call_id: 'call-1' }),
			{ type: 'transfer_completed', callId: 'call-1' },
			NOW,
		)
		expect(r.status).toBe('voice_warm_transferred')
	})

	it('transfer_failed changes nothing; the hangup resolves the contact', () => {
		const c = contact('voice_answered', { last_call_id: 'call-1' })
		expect(advance(c, { type: 'transfer_failed', callId: 'call-1' }, NOW).applied).toBe(false)
	})
})

describe('call_hangup: no_answer', () => {
	it('sets voice_no_answer, fires the missed-call SMS and requeues one workday later', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-1', dial_attempt_n: 1 })
		const r = advance(c, hangup('no_answer'), NOW)
		expect(r.status).toBe('voice_no_answer')
		expect(r.effects).toEqual([
			{ type: 'send_sms', mode: 'missed_call_nudge', to: '+4511111111', from: '+4522222222' },
		])
		// Thu 11:00 CEST + 1 workday = Fri 11:00 CEST
		expect(r.metadata.next_dial_at).toBe('2026-10-02T09:00:00.000Z')
	})

	it('treats timeout as no_answer', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-1', dial_attempt_n: 1 })
		expect(advance(c, hangup('timeout'), NOW).status).toBe('voice_no_answer')
	})

	it('the third attempt that rings out fails the contact', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-3', dial_attempt_n: 3 })
		const r = advance(c, hangup('no_answer', 'call-3'), NOW)
		expect(r.status).toBe('voice_failed')
		expect(r.metadata.next_dial_at).toBeNull()
	})

	it('walks three attempts end to end: queued, no_answer, no_answer, voice_failed', () => {
		const events = (n: number): VoiceEvent[] => [
			initiated(`call-${n}`, { dialAttemptN: n } as Partial<VoiceEvent>),
			hangup('no_answer', `call-${n}`),
		]
		let c = contact('voice_queued')
		c = run(c, events(1))
		expect(c.status).toBe('voice_no_answer')
		c = run(c, events(2))
		expect(c.status).toBe('voice_no_answer')
		c = run(c, events(3))
		expect(c.status).toBe('voice_failed')
	})
})

describe('call_hangup: busy', () => {
	it('sets voice_busy and requeues two hours later with no SMS', () => {
		const c = contact('voice_dialing', {
			last_call_id: 'call-1',
			dial_attempt_n: 1,
			dial_day: TODAY,
			dial_day_attempts: 1,
		})
		const r = advance(c, hangup('busy'), NOW)
		expect(r.status).toBe('voice_busy')
		expect(r.effects).toEqual([])
		expect(r.metadata.next_dial_at).toBe('2026-10-01T11:00:00.000Z')
	})

	it('treats user_busy as busy', () => {
		const c = contact('voice_dialing', {
			last_call_id: 'call-1',
			dial_day: TODAY,
			dial_day_attempts: 1,
		})
		expect(advance(c, hangup('user_busy'), NOW).status).toBe('voice_busy')
	})

	it('the second same-day busy fails the contact', () => {
		const c = contact('voice_dialing', {
			last_call_id: 'call-2',
			dial_attempt_n: 2,
			dial_day: TODAY,
			dial_day_attempts: 2,
		})
		expect(advance(c, hangup('busy', 'call-2'), NOW).status).toBe('voice_failed')
	})

	it('a busy after a no_answer yesterday still gets its retry today', () => {
		let c = contact('voice_no_answer', {
			dial_attempt_n: 1,
			dial_day: '2026-09-30',
			dial_day_attempts: 1,
			last_call_id: 'old',
		})
		c = run(c, [initiated('call-2')])
		expect(c.metadata?.dial_day_attempts).toBe(1)
		expect(advance(c, hangup('busy', 'call-2'), NOW).status).toBe('voice_busy')
	})
})

describe('call_hangup: machine_detected', () => {
	it('sets voicemail, fires the voicemail SMS and requeues two workdays later', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-1', dial_attempt_n: 1 })
		const r = advance(c, hangup('machine_detected'), NOW)
		expect(r.status).toBe('voice_voicemail')
		expect(r.effects).toEqual([
			{ type: 'send_sms', mode: 'voicemail_followup', to: '+4511111111', from: '+4522222222' },
		])
		expect(r.metadata.next_dial_at).toBe('2026-10-05T09:00:00.000Z')
	})

	it('after the one retry the next voicemail fails the contact', () => {
		const c = contact('voice_dialing', {
			last_call_id: 'call-2',
			dial_attempt_n: 2,
			voicemail_n: 1,
		})
		expect(advance(c, hangup('machine_detected', 'call-2'), NOW).status).toBe('voice_failed')
	})
})

describe('call_hangup: other causes and failures', () => {
	it('an unmapped cause is non-recoverable', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-1' })
		const r = advance(c, hangup('call_rejected'), NOW)
		expect(r.status).toBe('voice_failed')
		expect(r.metadata.voice_end_reason).toBe('call_rejected')
	})

	it('ignores a hangup for an older call', () => {
		const c = contact('voice_dialing', { last_call_id: 'call-2' })
		expect(advance(c, hangup('no_answer', 'call-1'), NOW).applied).toBe(false)
	})

	it('rest_failure fails the contact and dead-letters', () => {
		const r = advance(
			contact('voice_queued'),
			{ type: 'rest_failure', reason: 'POST /v2/calls 503 after 3 attempts' },
			NOW,
		)
		expect(r.status).toBe('voice_failed')
		expect(r.effects).toEqual([
			{ type: 'dead_letter', reason: 'POST /v2/calls 503 after 3 attempts' },
		])
		expect(r.metadata.next_dial_at).toBeNull()
	})
})

describe('full walks', () => {
	it('dial, answered, human, confirm, hangup => voice_meeting_booked', () => {
		const c = run(contact('voice_queued'), [
			initiated(),
			answered(),
			{ type: 'machine_detection', callId: 'call-1', result: 'human' },
		])
		expect(c.status).toBe('voice_answered')
		expect(c.metadata?.amd_result).toBe('human')
		const withTrace = {
			...c,
			metadata: { ...c.metadata, voice_tool_trace: [{ tool_name: 'confirm_meeting_slot' }] },
		}
		expect(run(withTrace, [hangup('normal_clearing')]).status).toBe('voice_meeting_booked')
	})
})

describe('voiceEventSchema', () => {
	it('rejects an event with no call id', () => {
		expect(voiceEventSchema.safeParse({ type: 'call_answered', callId: '' }).success).toBe(false)
	})
})
