import { describe, expect, it } from 'vitest'
import { MAX_MESSAGE_MENTIONS, sendMessageSchema } from '../schemas/conversations'

const uuid = (n: number) => `00000000-0000-0000-0000-${n.toString().padStart(12, '0')}`

describe('sendMessageSchema', () => {
	it('accepts a message with no mentions field', () => {
		const result = sendMessageSchema.parse({ content: 'hello' })
		expect(result.content).toBe('hello')
		expect(result.mentions).toBeUndefined()
	})

	it('accepts a message with mentions at the max bound', () => {
		const mentions = Array.from({ length: MAX_MESSAGE_MENTIONS }, (_, i) => uuid(i))
		const result = sendMessageSchema.parse({ content: 'hey team', mentions })
		expect(result.mentions).toHaveLength(MAX_MESSAGE_MENTIONS)
	})

	it('rejects a message with more than the max mentions', () => {
		const mentions = Array.from({ length: MAX_MESSAGE_MENTIONS + 1 }, (_, i) => uuid(i))
		expect(sendMessageSchema.safeParse({ content: 'hey', mentions }).success).toBe(false)
	})
})
