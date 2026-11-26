import type { MessageResponse } from '@/lib/api'
import { answeredQuestionIds } from '@/lib/question-answers'
import { describe, expect, it } from 'vitest'

const QUESTION = {
	session_id: '11111111-1111-1111-1111-111111111111',
	questions: [
		{ question: 'When?', header: 'Date', multi_select: false, options: [{ label: 'Now' }] },
	],
}

function msg(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: 'c',
		actorId: 'me',
		actorName: 'Me',
		actorType: 'human',
		kind: 'message',
		content: `m${id}`,
		metadata: null,
		sessionId: null,
		createdAt: null,
		editedAt: null,
		...overrides,
	}
}

const ask = (id: number, overrides: Partial<MessageResponse> = {}) =>
	msg(id, { actorId: 'agent', actorType: 'agent', metadata: { question: QUESTION }, ...overrides })

const ids = (answered: Map<number, unknown>) => new Set(answered.keys())

describe('answeredQuestionIds', () => {
	it('closes a question when the viewer types a normal message after it', () => {
		expect([...answeredQuestionIds([ask(1), msg(2)], 'me').keys()]).toEqual([1])
	})

	it('ignores a message from another person in the chat', () => {
		expect(answeredQuestionIds([ask(1), msg(2, { actorId: 'sam' })], 'me').size).toBe(0)
	})

	it('ignores a message that is still sending (temporary negative id)', () => {
		expect(answeredQuestionIds([ask(1), msg(-1)], 'me').size).toBe(0)
	})

	it('ignores system lines, agents, hidden card nudges and helper results', () => {
		const later = [
			msg(2, { kind: 'system' }),
			msg(3, { actorType: 'agent', actorId: 'me' }),
			msg(4, { metadata: { hidden_from_chat: true } }),
			msg(5, { metadata: { helper_return: 'x' } }),
		]
		expect(answeredQuestionIds([ask(1), ...later], 'me').size).toBe(0)
	})

	it('does not close a question for a message written before it', () => {
		expect(answeredQuestionIds([msg(1), ask(2)], 'me').size).toBe(0)
	})

	it('closes nothing when only older messages are loaded', () => {
		// The question's reply is not in the loaded page: nothing is decided by position.
		expect(answeredQuestionIds([ask(1)], 'me').size).toBe(0)
	})

	it('keeps a helper question open: only a pick answers it', () => {
		const helper = ask(1, { metadata: { question: { ...QUESTION, reply_to_session: true } } })
		expect(answeredQuestionIds([helper, msg(2)], 'me').size).toBe(0)
	})

	it('does not close a main-chat question for a reply written in a thread', () => {
		expect(answeredQuestionIds([ask(1), msg(2, { threadRootId: 1 })], 'me').size).toBe(0)
	})

	it('closes a question inside a thread for a reply in the same thread only', () => {
		const inThread = ask(3, { threadRootId: 1 })
		expect(ids(answeredQuestionIds([inThread, msg(4, { threadRootId: 1 })], 'me'))).toEqual(
			new Set([3]),
		)
		expect(answeredQuestionIds([inThread, msg(4)], 'me').size).toBe(0)
	})

	it('counts a pick from anyone, and a dismissal, as an answer', () => {
		const pick = msg(2, {
			actorId: 'sam',
			metadata: {
				question_answer: {
					question_message_id: 1,
					answers: [{ header: 'Date', selected: ['Now'] }],
				},
			},
		})
		expect(ids(answeredQuestionIds([ask(1), pick], 'me'))).toEqual(new Set([1]))
	})

	it('closes only the newest open question, so an older one stays open', () => {
		expect(ids(answeredQuestionIds([ask(1), ask(2), msg(3)], 'me'))).toEqual(new Set([2]))
	})

	it('each later reply closes the next newest open question', () => {
		const state = answeredQuestionIds([ask(1), ask(2), msg(3), ask(4), msg(5)], 'me')
		expect(new Set(state.keys())).toEqual(new Set([2, 4]))
	})

	it('skips a question already picked when choosing the newest open one', () => {
		const pick = msg(3, {
			metadata: {
				question_answer: {
					question_message_id: 2,
					answers: [{ header: 'Date', selected: ['Now'] }],
				},
			},
		})
		expect(ids(answeredQuestionIds([ask(1), ask(2), pick, msg(4)], 'me'))).toEqual(new Set([2, 1]))
	})

	it('does not treat a pick with no chosen option as an answer', () => {
		const empty = msg(2, {
			actorId: 'sam',
			metadata: { question_answer: { question_message_id: 1, answers: [] } },
		})
		const noneSelected = msg(3, {
			actorId: 'sam',
			metadata: {
				question_answer: {
					question_message_id: 1,
					answers: [{ header: 'Date', selected: [] }],
				},
			},
		})
		expect(answeredQuestionIds([ask(1), empty, noneSelected], 'me').size).toBe(0)
	})

	it('decides nothing without a known viewer', () => {
		expect(answeredQuestionIds([ask(1), msg(2)], undefined).size).toBe(0)
	})
})

describe('answeredQuestionIds: what the summary keeps', () => {
	it('keeps the pick with who picked it and when', () => {
		const pick = msg(2, {
			actorName: 'Sam',
			createdAt: '2026-11-24T08:04:00Z',
			metadata: {
				question_answer: {
					question_message_id: 1,
					answers: [{ header: 'Date', selected: ['Now'] }],
				},
			},
		})
		expect(answeredQuestionIds([ask(1), pick], 'me').get(1)).toEqual({
			picks: [{ header: 'Date', selected: ['Now'] }],
			text: null,
			actorName: 'Sam',
			createdAt: '2026-11-24T08:04:00Z',
		})
	})

	it('keeps the typed words when a normal message closed the question', () => {
		const typed = msg(2, { content: 'Tomorrow', createdAt: '2026-11-24T09:00:00Z' })
		expect(answeredQuestionIds([ask(1), typed], 'me').get(1)).toEqual({
			picks: [],
			text: 'Tomorrow',
			actorName: 'Me',
			createdAt: '2026-11-24T09:00:00Z',
		})
	})

	it('lets the pick win over a typed reply', () => {
		const pick = msg(3, {
			actorName: 'Sam',
			metadata: {
				question_answer: {
					question_message_id: 1,
					answers: [{ header: 'Date', selected: ['Now'] }],
				},
			},
		})
		expect(answeredQuestionIds([ask(1), msg(2), pick], 'me').get(1)?.picks).toHaveLength(1)
	})
})
