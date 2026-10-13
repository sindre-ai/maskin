import { describe, expect, it } from 'vitest'
import { HUMAN_MESSAGE_STYLE, HUMAN_MESSAGE_STYLE_SHORT } from '../prompts'
import { createCommentSchema } from '../schemas/events'

describe('HUMAN_MESSAGE_STYLE', () => {
	it('tells agents to lead with the point and avoid the em dash', () => {
		expect(HUMAN_MESSAGE_STYLE).toContain('Lead with the point')
		expect(HUMAN_MESSAGE_STYLE).toContain('em dash')
	})

	it('is surfaced in the comment content field description', () => {
		const description = createCommentSchema.shape.content.description ?? ''
		expect(description).toContain(HUMAN_MESSAGE_STYLE_SHORT)
	})
})
