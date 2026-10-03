import { describe, expect, it } from 'vitest'
import { callOutcome } from '../../../lib/outreach/voice/posthog-events'

describe('callOutcome', () => {
	it.each([
		'voice_declined',
		'voice_meeting_booked',
		'voice_warm_transferred',
		'follow_up_later',
		'voice_answered',
	])('%s is answered', (status) => {
		expect(callOutcome(status, {})).toBe('answered')
	})

	it('is voicemail on the voicemail status, or after a machine verdict that ended in voice_failed', () => {
		expect(callOutcome('voice_voicemail', {})).toBe('voicemail')
		expect(
			callOutcome('voice_failed', { amd_result: 'machine', voice_end_reason: 'machine_detected' }),
		).toBe('voicemail')
	})

	it.each(['voice_no_answer', 'voice_busy', 'voice_failed', 'voice_dialing', 'voice_queued'])(
		'%s with no machine verdict is no_answer',
		(status) => {
			expect(callOutcome(status, { amd_result: 'human' })).toBe('no_answer')
			expect(callOutcome(status, {})).toBe('no_answer')
		},
	)
})
