import { formatCallClock, parseVoiceReceipt, voiceReceiptLabel } from '@/lib/voice-receipts'
import { describe, expect, it } from 'vitest'

const row = {
	source: 'voice',
	voice_session_id: 'vs-1',
	kind: 'receipt',
	event: 'created_task',
	object_id: 'obj-1',
	text: 'Backfill cancelled bookings dropped before the fix',
	t: 164,
	outcome: 'ran',
}

const summary = {
	source: 'voice',
	voice_session_id: 'vs-1',
	kind: 'receipt_summary',
	duration_seconds: 3604,
	decided: ['Backfill cancelled bookings', 'Keep the Cal.com cancel in this PR'],
	created: [
		{ type: 'bet', title: 'Backfill cancelled bookings', object_id: 'obj-2' },
		{ type: 'task', title: 'Task moved to review', object_id: null },
	],
	next: ['Code Reviewer picks up the PR today'],
	not_done: [],
}

describe('parseVoiceReceipt', () => {
	it('reads an event row', () => {
		expect(parseVoiceReceipt(row)).toEqual({
			kind: 'receipt',
			voiceSessionId: 'vs-1',
			event: 'created_task',
			objectId: 'obj-1',
			text: 'Backfill cancelled bookings dropped before the fix',
			t: 164,
			outcome: 'ran',
		})
	})

	it('falls back to "other" and "ran" for unknown event and outcome values', () => {
		const parsed = parseVoiceReceipt({ ...row, event: 'archived_thing', outcome: 'weird' })
		expect(parsed).toMatchObject({ kind: 'receipt', event: 'other', outcome: 'ran' })
	})

	it('keeps a row that names no object', () => {
		expect(parseVoiceReceipt({ ...row, object_id: undefined })).toMatchObject({ objectId: null })
	})

	it('drops a row with no text', () => {
		expect(parseVoiceReceipt({ ...row, text: '  ' })).toBeNull()
	})

	it('clamps a bad time to zero', () => {
		expect(parseVoiceReceipt({ ...row, t: -4 })).toMatchObject({ t: 0 })
		expect(parseVoiceReceipt({ ...row, t: 'soon' })).toMatchObject({ t: 0 })
	})

	it('reads a summary', () => {
		expect(parseVoiceReceipt(summary)).toEqual({
			kind: 'receipt_summary',
			voiceSessionId: 'vs-1',
			durationSeconds: 3604,
			decided: summary.decided,
			created: [
				{ type: 'bet', title: 'Backfill cancelled bookings', objectId: 'obj-2' },
				{ type: 'task', title: 'Task moved to review', objectId: null },
			],
			next: summary.next,
			notDone: [],
		})
	})

	it('tolerates a summary with missing lists and skips malformed created entries', () => {
		const parsed = parseVoiceReceipt({
			source: 'voice',
			kind: 'receipt_summary',
			created: [{ type: 'bet' }, 'nope', { type: 'bet', title: 'Kept' }],
		})
		expect(parsed).toMatchObject({
			durationSeconds: 0,
			decided: [],
			next: [],
			notDone: [],
			created: [{ type: 'bet', title: 'Kept', objectId: null }],
		})
	})

	it('returns null for anything that is not a voice receipt', () => {
		expect(parseVoiceReceipt(null)).toBeNull()
		expect(parseVoiceReceipt([])).toBeNull()
		expect(parseVoiceReceipt({ source: 'text', kind: 'receipt', text: 'x' })).toBeNull()
		expect(parseVoiceReceipt({ source: 'voice' })).toBeNull()
		expect(parseVoiceReceipt({ source: 'voice', kind: 'transcript' })).toBeNull()
	})
})

describe('formatCallClock', () => {
	it('uses m:ss under an hour', () => {
		expect(formatCallClock(0)).toBe('0:00')
		expect(formatCallClock(37)).toBe('0:37')
		expect(formatCallClock(754)).toBe('12:34')
	})

	it('uses h:mm:ss from one hour', () => {
		expect(formatCallClock(3600)).toBe('1:00:00')
		expect(formatCallClock(3604)).toBe('1:00:04')
	})

	it('never goes negative', () => {
		expect(formatCallClock(-3)).toBe('0:00')
	})
})

describe('voiceReceiptLabel', () => {
	it('names every event', () => {
		expect(voiceReceiptLabel('created_bet')).toBe('Created bet')
		expect(voiceReceiptLabel('moved_to_review')).toBe('Moved to review')
		expect(voiceReceiptLabel('other')).toBe('Changed')
	})
})
