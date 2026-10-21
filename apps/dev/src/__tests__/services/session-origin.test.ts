import { describe, expect, it } from 'vitest'
import { originConversationOf } from '../../services/session-origin'

const OWN = '11111111-1111-4111-8111-111111111111'
const STAMPED = '22222222-2222-4222-8222-222222222222'
const ASKED = '33333333-3333-4333-8333-333333333333'

describe('originConversationOf', () => {
	it('prefers the session own conversation', () => {
		expect(
			originConversationOf({
				conversationId: OWN,
				config: { origin_conversation_id: STAMPED, ask_conversation_id: ASKED },
			}),
		).toBe(OWN)
	})

	it('falls back to origin_conversation_id', () => {
		expect(
			originConversationOf({
				conversationId: null,
				config: { origin_conversation_id: STAMPED, ask_conversation_id: ASKED },
			}),
		).toBe(STAMPED)
	})

	it('falls back to ask_conversation_id for a helper that only carries that', () => {
		expect(
			originConversationOf({ conversationId: null, config: { ask_conversation_id: ASKED } }),
		).toBe(ASKED)
	})

	it('returns null when the session has no chat origin', () => {
		expect(originConversationOf({ conversationId: null, config: {} })).toBeNull()
	})

	it('ignores values that are not a non-empty string', () => {
		expect(
			originConversationOf({
				conversationId: null,
				config: { origin_conversation_id: 7, ask_conversation_id: '' },
			}),
		).toBeNull()
	})

	it('does not throw on a null config', () => {
		expect(originConversationOf({ conversationId: null, config: null })).toBeNull()
	})
})
