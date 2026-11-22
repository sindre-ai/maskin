import type { MessageResponse } from '@/lib/api'
import { findLastEditableMessage } from '@/lib/last-editable-message'
import { describe, expect, it } from 'vitest'

function msg(overrides: Partial<MessageResponse>): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'me',
		actorName: 'Me',
		actorType: 'human',
		kind: 'message',
		content: 'hello',
		metadata: null,
		sessionId: null,
		createdAt: null,
		editedAt: null,
		...overrides,
	}
}

describe('findLastEditableMessage', () => {
	it('returns the newest message of your own', () => {
		const list = [
			msg({ id: 1 }),
			msg({ id: 2, actorId: 'agent' }),
			msg({ id: 3 }),
			msg({ id: 4, actorId: 'agent' }),
		]
		expect(findLastEditableMessage(list, 'me')?.id).toBe(3)
	})

	it('passes over optimistic, system, deleted, attachment-only and thread-only messages', () => {
		const list = [
			msg({ id: 1 }),
			msg({ id: 2, kind: 'system' }),
			msg({ id: 3, deletedAt: '2026-11-11T10:00:00Z' }),
			msg({ id: 4, content: '' }),
			msg({ id: 5, threadRootId: 1 }),
			msg({ id: -1 }),
		]
		expect(findLastEditableMessage(list, 'me')?.id).toBe(1)
	})

	it('keeps a reply that was also sent to the main chat', () => {
		expect(
			findLastEditableMessage([msg({ id: 6, threadRootId: 1, threadAlsoInChannel: true })], 'me')
				?.id,
		).toBe(6)
	})

	it('returns null with no message of your own or no actor', () => {
		expect(findLastEditableMessage([msg({ actorId: 'agent' })], 'me')).toBeNull()
		expect(findLastEditableMessage([msg({})], undefined)).toBeNull()
	})
})
