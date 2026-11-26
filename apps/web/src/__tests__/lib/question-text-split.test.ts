import { splitQuestionText } from '@/lib/question-text-split'
import { describe, expect, it } from 'vitest'

// The same cases as QuestionTextSplitTests on iPhone, so the two stay one rule.
const draft =
	'Subject: Luma event\n\nHi Maya, thanks for hosting us next week. We would love to bring two people.'

describe('splitQuestionText', () => {
	it('splits a question followed by a long text at the question mark', () => {
		const split = splitQuestionText(`Send this to Maya? ${draft}`)
		expect(split.lead).toBe('Send this to Maya?')
		expect(split.detail).toBe(draft)
	})

	it('keeps a short text after the question mark whole', () => {
		const split = splitQuestionText('Ship it now? Yes or no.')
		expect(split.lead).toBe('Ship it now? Yes or no.')
		expect(split.detail).toBeNull()
	})

	it('does not treat a question mark inside a link as a question', () => {
		const text =
			'See https://maskin.io/x?tab=1 for the page and tell me what you think about the wording there'
		expect(splitQuestionText(text).detail).toBeNull()
	})

	it('splits a long text with no question after the first sentence', () => {
		const rest = 'More detail follows here. '.repeat(6).trim()
		const split = splitQuestionText(`Pick the launch date. ${rest}`)
		expect(split.lead).toBe('Pick the launch date.')
		expect(split.detail).toBe(rest)
	})

	it('keeps a short text with no question as the lead', () => {
		const split = splitQuestionText('Which one?')
		expect(split.lead).toBe('Which one?')
		expect(split.detail).toBeNull()
	})

	it('keeps the line breaks in the detail', () => {
		expect(splitQuestionText(`Is this right? ${draft}`).detail).toContain('\n\n')
	})
})
