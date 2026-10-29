import { splitLongMessage } from '@/lib/long-message'
import { MESSAGE_MAX_LENGTH } from '@maskin/shared'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-10-27T13:45:09Z')

describe('splitLongMessage', () => {
	it('leaves text at the cap alone', () => {
		expect(splitLongMessage('x'.repeat(MESSAGE_MAX_LENGTH), NOW)).toBeNull()
	})

	it('splits text one character over the cap into one file and a short body', () => {
		const split = splitLongMessage('x'.repeat(MESSAGE_MAX_LENGTH + 1), NOW)
		expect(split?.file.content).toHaveLength(MESSAGE_MAX_LENGTH + 1)
		expect(split?.body.length).toBeLessThan(MESSAGE_MAX_LENGTH)
	})

	it('keeps all of the text in the file and a short body under the cap', () => {
		const text = `${'word '.repeat(3000)}end`
		const split = splitLongMessage(text, NOW)
		expect(split).not.toBeNull()
		expect(split?.file.content).toBe(text)
		expect(split?.file.name).toBe('message-2026-10-27-13-45-09.txt')
		expect(split?.body.length).toBeLessThan(MESSAGE_MAX_LENGTH)
		expect(split?.body.startsWith('word word')).toBe(true)
		expect(split?.body).toContain('15,003 characters')
		expect(split?.body).toContain(split?.file.name)
	})

	it('cuts the preview on a word, not in the middle of one', () => {
		const split = splitLongMessage(`${'abcdefghi '.repeat(1000)}`, NOW)
		expect(split?.body.split('…')[0].endsWith('abcdefghi')).toBe(true)
	})
})
