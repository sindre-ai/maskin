import { pendingComputerTasks } from '@/components/chat/computers-pane'
import type { MessageResponse } from '@/lib/api'
import { describe, expect, it } from 'vitest'

const msg = (
	id: number,
	actorId: string,
	actorType: 'human' | 'agent',
	metadata: MessageResponse['metadata'] = null,
): MessageResponse => ({
	id,
	conversationId: 'c1',
	actorId,
	actorName: actorId,
	actorType,
	kind: 'message',
	content: 'x',
	metadata,
	sessionId: null,
	createdAt: null,
	editedAt: null,
})

describe('pendingComputerTasks()', () => {
	it('holds an agent’s request until a person writes', () => {
		const messages = [
			msg(1, 'a1', 'agent', { computer_request: { session_id: 's', task: 'Sign in' } }),
		]
		expect(pendingComputerTasks(messages).get('a1')).toBe('Sign in')
		expect(pendingComputerTasks([...messages, msg(2, 'me', 'human')]).size).toBe(0)
	})

	it('keeps one request per agent, the latest', () => {
		const messages = [
			msg(1, 'a1', 'agent', { computer_request: { session_id: 's', task: 'Old' } }),
			msg(2, 'a1', 'agent', { computer_request: { session_id: 's', task: 'New' } }),
			msg(3, 'a2', 'agent', { computer_request: { session_id: 's', task: 'Other' } }),
		]
		const pending = pendingComputerTasks(messages)
		expect(pending.get('a1')).toBe('New')
		expect(pending.get('a2')).toBe('Other')
	})
})
