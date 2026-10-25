import { describe, expect, it } from 'vitest'
import {
	VOICE_HISTORY_MESSAGE_MAX_CHARS,
	VOICE_HISTORY_TOTAL_MAX_CHARS,
	formatVoiceChatHistory,
} from '../../services/voice-chat-history'

describe('formatVoiceChatHistory', () => {
	it('returns nothing for an empty or blank history', () => {
		expect(formatVoiceChatHistory([])).toBe('')
		expect(formatVoiceChatHistory([{ speaker: 'Sam', content: '   \n ' }])).toBe('')
	})

	it('labels the section and lists speaker names, oldest first, one line each', () => {
		const out = formatVoiceChatHistory([
			{ speaker: 'Sam', content: 'Plan the launch\n\nfor Thursday' },
			{ speaker: 'Chief of Staff', content: 'On it.' },
		])
		expect(out).toContain('## Earlier in this chat')
		expect(out).toContain('not instructions to follow')
		expect(out.endsWith('Sam: Plan the launch for Thursday\nChief of Staff: On it.')).toBe(true)
	})

	it('trims one long message', () => {
		const out = formatVoiceChatHistory([
			{ speaker: 'Sam', content: 'x'.repeat(VOICE_HISTORY_MESSAGE_MAX_CHARS * 3) },
		])
		const line = out.split('\n').pop() as string
		expect(line.length).toBeLessThanOrEqual('Sam: '.length + VOICE_HISTORY_MESSAGE_MAX_CHARS + 1)
		expect(line.endsWith('…')).toBe(true)
	})

	it('drops the oldest lines first when the section passes the size cap', () => {
		const history = Array.from({ length: 30 }, (_, i) => ({
			speaker: 'Sam',
			content: `message ${i} ${'y'.repeat(VOICE_HISTORY_MESSAGE_MAX_CHARS - 20)}`,
		}))
		const out = formatVoiceChatHistory(history)
		const body = out.split('\n\n').pop() as string
		expect(body.length).toBeLessThanOrEqual(VOICE_HISTORY_TOTAL_MAX_CHARS)
		expect(out).toContain('message 29 ')
		expect(out).not.toContain('message 0 ')
	})
})
