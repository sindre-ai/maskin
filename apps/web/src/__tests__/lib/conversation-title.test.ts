import { deriveConversationTitle } from '@maskin/shared'
import { describe, expect, it } from 'vitest'

describe('deriveConversationTitle', () => {
	it('returns the fallback when the message is empty or whitespace', () => {
		expect(deriveConversationTitle('', 'Chief of Staff')).toBe('Chief of Staff')
		expect(deriveConversationTitle('   \n\t ', 'Chief of Staff')).toBe('Chief of Staff')
	})

	it('titles by topic, dropping request phrasing and filler words', () => {
		expect(
			deriveConversationTitle(
				'Please review the scope of the YouTube integration and tell me what is missing.',
				'Developer',
			),
		).toBe('Scope YouTube integration')
		expect(deriveConversationTitle("Let's update the knowledge base about pricing", 'Relay')).toBe(
			'Knowledge base pricing',
		)
	})

	it('keeps the keywords of a short question', () => {
		expect(deriveConversationTitle('Which accounts went quiet?', 'Sentinel')).toBe(
			'Accounts went quiet',
		)
	})

	it('uses the first message sentence as the title when too few keywords are left', () => {
		expect(deriveConversationTitle('We shipped v3. Now what?', 'Relay')).toBe('We shipped v3.')
	})

	it('takes only the first sentence of a multi-sentence message', () => {
		expect(
			deriveConversationTitle(
				'Why did trial signups dip last week? I want the product or the channel, not both.',
				'Compass',
			),
		).toBe('Trial signups dip last week')
	})

	it('collapses newlines and runs of whitespace', () => {
		expect(deriveConversationTitle('Reindex\n\n  the   billing   tables', 'Relay')).toBe(
			'Reindex billing tables',
		)
	})

	it('keeps at most five keywords', () => {
		const title = deriveConversationTitle(
			'Draft the note to Acme about the retry window before Thursday and include the usage numbers we pulled',
			'Relay',
		)
		expect(title).toBe('Note Acme retry window Thursday')
	})

	it('does not treat a decimal point as the end of a sentence', () => {
		expect(deriveConversationTitle('Ship 3.5 to the beta cohort by Friday', 'Relay')).toBe(
			'Ship 3.5 beta cohort Friday',
		)
	})

	it('does not cut inside a URL', () => {
		expect(deriveConversationTitle('Check https://acme.com/dash for the drop', 'Relay')).toBe(
			'Check https://acme.com/dash for…',
		)
	})

	it('keeps the message when the first "sentence" is only an abbreviation', () => {
		expect(deriveConversationTitle('Dr. Ruiz wants the Q3 numbers', 'Relay')).toBe(
			'Dr Ruiz wants Q3 numbers',
		)
		expect(deriveConversationTitle('e.g. why did signups dip?', 'Relay')).toBe('E.g signups dip')
	})

	it('cuts mid-word when a word boundary would leave a stub', () => {
		const long = `Reindex ${'x'.repeat(120)}`
		const title = deriveConversationTitle(long, 'Relay')
		expect(title).toBe(`${long.slice(0, 32)}…`)
	})

	it('falls back to the whole message when it opens with punctuation', () => {
		expect(deriveConversationTitle('?!', 'Chief of Staff')).toBe('?!')
	})
})
