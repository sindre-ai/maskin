import { deriveConversationTitle } from '@/lib/conversation-title'
import { describe, expect, it } from 'vitest'

describe('deriveConversationTitle', () => {
	it('returns the fallback when the message is empty or whitespace', () => {
		expect(deriveConversationTitle('', 'Chief of Staff')).toBe('Chief of Staff')
		expect(deriveConversationTitle('   \n\t ', 'Chief of Staff')).toBe('Chief of Staff')
	})

	it('keeps a short message intact, including its question mark', () => {
		expect(deriveConversationTitle('Which accounts went quiet this week?', 'Sentinel')).toBe(
			'Which accounts went quiet this week?',
		)
	})

	it('takes only the first sentence of a multi-sentence message', () => {
		expect(
			deriveConversationTitle(
				'Why did trial signups dip last week? I want the product or the channel, not both.',
				'Compass',
			),
		).toBe('Why did trial signups dip last week?')
	})

	it('collapses newlines and runs of whitespace', () => {
		expect(deriveConversationTitle('Catch me up\n\n  on   billing', 'Relay')).toBe(
			'Catch me up on billing',
		)
	})

	it('cuts a long sentence on a word boundary and marks the cut', () => {
		const long =
			'Draft the note to Acme about the retry window before Thursday and include the usage numbers we pulled'
		const title = deriveConversationTitle(long, 'Relay')
		expect(title.endsWith('…')).toBe(true)
		expect(title.length).toBeLessThanOrEqual(73)
		expect(title).not.toMatch(/\s…$/)
		// Cut on a word boundary — the last kept word is whole.
		expect(long.startsWith(title.slice(0, -1))).toBe(true)
	})

	it('does not treat a decimal point as the end of a sentence', () => {
		expect(deriveConversationTitle('Ship 3.5 to the beta cohort by Friday', 'Relay')).toBe(
			'Ship 3.5 to the beta cohort by Friday',
		)
	})

	it('does not cut inside a URL', () => {
		expect(deriveConversationTitle('Check https://acme.com/dash for the drop', 'Relay')).toBe(
			'Check https://acme.com/dash for the drop',
		)
	})

	it('keeps the message when the first "sentence" is only an abbreviation', () => {
		expect(deriveConversationTitle('Dr. Ruiz wants the Q3 numbers', 'Relay')).toBe(
			'Dr. Ruiz wants the Q3 numbers',
		)
		expect(deriveConversationTitle('e.g. why did signups dip?', 'Relay')).toBe(
			'e.g. why did signups dip?',
		)
	})

	it('still ends the sentence on a digit when the terminator is a real one', () => {
		expect(deriveConversationTitle('We shipped v3. Now what?', 'Relay')).toBe('We shipped v3.')
	})

	it('cuts mid-word when a word boundary would leave a stub', () => {
		const long = `Reindex ${'x'.repeat(120)}`
		const title = deriveConversationTitle(long, 'Relay')
		expect(title).toBe(`${long.slice(0, 72)}…`)
	})

	it('falls back to the whole message when it opens with punctuation', () => {
		expect(deriveConversationTitle('?!', 'Chief of Staff')).toBe('?!')
	})
})
