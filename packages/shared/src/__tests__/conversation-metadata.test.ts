import { describe, expect, it } from 'vitest'
import { messageMetadataSchema, stripServerOwnedMetadata } from '../schemas/conversations'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

describe('stripServerOwnedMetadata', () => {
	it('removes integration_connect so a client cannot forge a Connect card', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			integration_connect: { session_id: SESSION_ID, provider: 'linear' },
		})

		expect(stripped).toEqual({ mentions: [SESSION_ID] })
	})

	it('removes helper_return so a client cannot forge the marker that hides a message', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			helper_return: SESSION_ID,
		})

		expect(stripped).toEqual({ mentions: [SESSION_ID] })
	})

	it('still removes the markers it already owned', () => {
		const stripped = stripServerOwnedMetadata({
			source: 'final_output',
			question: { session_id: SESSION_ID, questions: [] },
			question_answer: { question_message_id: 1, answers: [] },
		})

		// question_answer is client-supplied by design, so it must survive.
		expect(stripped).toEqual({ question_answer: { question_message_id: 1, answers: [] } })
	})
})

describe('messageMetadataSchema integration_connect', () => {
	it('accepts a session id and a provider name', () => {
		const parsed = messageMetadataSchema.safeParse({
			integration_connect: { session_id: SESSION_ID, provider: 'linear' },
		})

		expect(parsed.success).toBe(true)
	})

	it('rejects a card with no provider or a non-uuid session', () => {
		expect(
			messageMetadataSchema.safeParse({
				integration_connect: { session_id: SESSION_ID, provider: '' },
			}).success,
		).toBe(false)
		expect(
			messageMetadataSchema.safeParse({
				integration_connect: { session_id: 'nope', provider: 'linear' },
			}).success,
		).toBe(false)
	})
})
