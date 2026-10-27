import {
	type VoiceTranscriptMessage,
	buildVoiceTranscript,
	isSpokenVoiceLine,
} from '@/lib/voice-transcript'
import { describe, expect, it } from 'vitest'

function msg(
	id: number,
	secondsIn: number,
	over: Partial<VoiceTranscriptMessage> = {},
): VoiceTranscriptMessage {
	return {
		id,
		content: `line ${id}`,
		createdAt: new Date(Date.UTC(2026, 9, 27, 14, 2, secondsIn)).toISOString(),
		actorName: 'Developer',
		actorType: 'agent',
		metadata: { source: 'voice', voice_session_id: 'vs-1' },
		...over,
	}
}

describe('isSpokenVoiceLine', () => {
	it('is true for a voice message that is not a receipt', () => {
		expect(isSpokenVoiceLine(msg(1, 0))).toBe(true)
	})

	it('is false for anything that carries a kind: receipts, summaries and show_in_chat', () => {
		const m = (metadata: VoiceTranscriptMessage['metadata']) => ({ metadata })
		expect(isSpokenVoiceLine(m({ source: 'voice', kind: 'receipt' }))).toBe(false)
		expect(isSpokenVoiceLine(m({ source: 'voice', kind: 'receipt_summary' }))).toBe(false)
		expect(isSpokenVoiceLine(m({ source: 'voice', kind: 'show' }))).toBe(false)
	})

	it('is false for ordinary messages', () => {
		const m = (metadata: VoiceTranscriptMessage['metadata']) => ({ metadata })
		expect(isSpokenVoiceLine(m(null))).toBe(false)
		expect(isSpokenVoiceLine(m({}))).toBe(false)
	})
})

describe('buildVoiceTranscript', () => {
	it('returns one entry per spoken line with time since the call began', () => {
		const lines = buildVoiceTranscript(
			[msg(1, 0, { actorType: 'human', actorName: 'Sebastian' }), msg(2, 18), msg(3, 3604)],
			'vs-1',
		)
		expect(lines).toEqual([
			{ id: 1, t: 0, speaker: 'You', text: 'line 1' },
			{ id: 2, t: 18, speaker: 'Developer', text: 'line 2' },
			{ id: 3, t: 3604, speaker: 'Developer', text: 'line 3' },
		])
	})

	it('counts from the call first message even when that is a receipt, and leaves receipts out', () => {
		const lines = buildVoiceTranscript(
			[
				msg(1, 0, {
					metadata: {
						source: 'voice',
						voice_session_id: 'vs-1',
						kind: 'receipt',
						text: 'Opened',
					} as never,
				}),
				msg(2, 12),
			],
			'vs-1',
		)
		expect(lines).toEqual([{ id: 2, t: 12, speaker: 'Developer', text: 'line 2' }])
	})

	it('leaves show_in_chat messages out of the transcript', () => {
		const lines = buildVoiceTranscript(
			[
				msg(1, 0),
				msg(2, 4, { metadata: { source: 'voice', voice_session_id: 'vs-1', kind: 'show' } }),
			],
			'vs-1',
		)
		expect(lines.map((l) => l.id)).toEqual([1])
	})

	it('keeps only the asked-for call, and ordinary messages out', () => {
		const lines = buildVoiceTranscript(
			[
				msg(1, 0),
				msg(2, 5, { metadata: { source: 'voice', voice_session_id: 'vs-2' } }),
				msg(3, 6, { metadata: null }),
			],
			'vs-1',
		)
		expect(lines.map((l) => l.id)).toEqual([1])
	})

	it('orders by message id and skips blank lines', () => {
		const lines = buildVoiceTranscript(
			[msg(5, 9), msg(2, 1, { content: '   ' }), msg(3, 4)],
			'vs-1',
		)
		expect(lines.map((l) => l.id)).toEqual([3, 5])
	})

	it('uses zero when timestamps are missing', () => {
		const lines = buildVoiceTranscript([msg(1, 0, { createdAt: null })], 'vs-1')
		expect(lines[0]?.t).toBe(0)
	})
})
