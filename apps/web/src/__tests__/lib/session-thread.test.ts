import { buildThreadChat } from '@/lib/session-thread'
import { describe, expect, it } from 'vitest'

const log = (id: number, envelope: unknown) => ({
	id,
	sessionId: 's1',
	stream: 'stdout',
	content: JSON.stringify(envelope),
	createdAt: null,
})

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const result = (text: string) => ({
	type: 'result',
	subtype: 'success',
	is_error: false,
	result: text,
})

const ctx = {
	conversationId: 'c1',
	sessionId: 's1',
	agent: { id: 'agent-1', name: 'Ledger', type: 'agent' as const },
	me: { id: 'me', name: 'Magnus', type: 'human' as const },
	prompt: {
		author: { id: 'agent-0', name: 'CTO', type: 'agent' as const },
		content: 'Get main green',
		createdAt: null,
	},
}

describe('buildThreadChat()', () => {
	it('starts with the prompt from whoever handed the work off', () => {
		const chat = buildThreadChat([], ctx)
		expect(chat.items).toHaveLength(1)
		expect(chat.items[0]?.message.actorName).toBe('CTO')
		expect(chat.items[0]?.message.content).toBe('Get main green')
	})

	it('does not show the prompt a second time from the first user envelope', () => {
		const chat = buildThreadChat([log(1, user('startup text + Get main green'))], ctx)
		expect(chat.items).toHaveLength(1)
	})

	it('turns each result into an agent message and a later user envelope into the person’s', () => {
		const chat = buildThreadChat(
			[
				log(1, user('prompt')),
				log(2, result('First answer')),
				log(3, user('Try again')),
				log(4, result('Second answer')),
			],
			ctx,
		)
		expect(chat.items.map((i) => [i.message.actorName, i.message.content])).toEqual([
			['CTO', 'Get main green'],
			['Ledger', 'First answer'],
			['Magnus', 'Try again'],
			['Ledger', 'Second answer'],
		])
	})

	it('gives every message a negative id so it cannot be edited or retried', () => {
		const chat = buildThreadChat([log(1, user('p')), log(2, result('Done'))], ctx)
		expect(chat.items.every((i) => i.message.id < 0)).toBe(true)
	})
})
