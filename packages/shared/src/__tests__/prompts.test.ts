import { describe, expect, it } from 'vitest'
import { HUMAN_MESSAGE_STYLE, HUMAN_MESSAGE_STYLE_SHORT } from '../prompts'
import { createCommentSchema } from '../schemas/events'

describe('HUMAN_MESSAGE_STYLE', () => {
	it('tells agents to lead with the point and avoid the em dash', () => {
		expect(HUMAN_MESSAGE_STYLE).toContain('Lead with the point')
		expect(HUMAN_MESSAGE_STYLE).toContain('em dash')
	})

	it('tells agents to restate open questions and not stop on ones they can recommend an answer to', () => {
		expect(HUMAN_MESSAGE_STYLE).toContain('Asking the human')
		expect(HUMAN_MESSAGE_STYLE).toContain('act on it')
		expect(HUMAN_MESSAGE_STYLE).toContain('Never write "the N open questions"')
	})

	it('is surfaced in the comment content field description', () => {
		const description = createCommentSchema.shape.content.description ?? ''
		expect(description).toContain(HUMAN_MESSAGE_STYLE_SHORT)
	})
})
