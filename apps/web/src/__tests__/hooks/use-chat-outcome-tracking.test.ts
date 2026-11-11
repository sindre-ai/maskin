import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackChatFirstReplyReceived: vi.fn(),
	trackChatLeft: vi.fn(),
	trackChatMessageResent: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me' }),
}))

import { useChatOutcomeTracking } from '@/hooks/use-chat-outcome-tracking'
import { trackChatFirstReplyReceived, trackChatLeft, trackChatMessageResent } from '@/lib/analytics'
import type { MessageResponse } from '@/lib/api'

let nextId = 1
function msg(
	actorType: 'human' | 'agent',
	actorId: string,
	kind: 'message' | 'system' = 'message',
) {
	return {
		id: nextId++,
		conversationId: 'c-1',
		actorId,
		actorName: actorId,
		actorType,
		kind,
		content: 'x',
		metadata: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
	} as MessageResponse
}

const mine = () => msg('human', 'me')
const agent = () => msg('agent', 'agent-1')

// Places a message `seconds` after a fixed start, so gaps between messages are exact.
const START = Date.parse('2026-11-11T10:00:00Z')
function at<T extends MessageResponse>(m: T, seconds: number): T {
	return { ...m, createdAt: new Date(START + seconds * 1000).toISOString() }
}

beforeEach(() => {
	vi.clearAllMocks()
	nextId = 1
})

function mount(initial: MessageResponse[], loaded = true) {
	return renderHook(
		({ messages, isLoaded, id }) => useChatOutcomeTracking(id, messages, isLoaded),
		{ initialProps: { messages: initial, isLoaded: loaded, id: 'c-1' } },
	)
}

describe('useChatOutcomeTracking', () => {
	it('sends chat_first_reply_received when an agent answers a chat the person wrote in', () => {
		const first = mine()
		const hook = mount([first])

		hook.rerender({ messages: [first, agent()], isLoaded: true, id: 'c-1' })

		expect(trackChatFirstReplyReceived).toHaveBeenCalledOnce()
		expect(trackChatFirstReplyReceived).toHaveBeenCalledWith(
			expect.objectContaining({ entity_id: 'c-1' }),
		)
	})

	it('carries the session id of the first agent message on chat_first_reply_received', () => {
		const first = mine()
		const hook = mount([first])

		hook.rerender({
			messages: [first, { ...agent(), sessionId: 'run-1' }],
			isLoaded: true,
			id: 'c-1',
		})

		expect(trackChatFirstReplyReceived).toHaveBeenCalledWith(
			expect.objectContaining({ session_id: 'run-1' }),
		)
	})

	it('sends it once, not again for the next agent message', () => {
		const first = mine()
		const reply = agent()
		const hook = mount([first])

		hook.rerender({ messages: [first, reply], isLoaded: true, id: 'c-1' })
		hook.rerender({ messages: [first, reply, agent()], isLoaded: true, id: 'c-1' })

		expect(trackChatFirstReplyReceived).toHaveBeenCalledOnce()
	})

	it('does not claim a reply that was already in the chat when it was opened', () => {
		const history = [mine(), agent()]
		const hook = mount(history)

		hook.rerender({ messages: [...history, mine(), agent()], isLoaded: true, id: 'c-1' })

		expect(trackChatFirstReplyReceived).not.toHaveBeenCalled()
	})

	it('waits for the messages to load before taking its baseline', () => {
		const hook = mount([], false)
		const history = [mine(), agent()]

		hook.rerender({ messages: history, isLoaded: true, id: 'c-1' })

		expect(trackChatFirstReplyReceived).not.toHaveBeenCalled()
	})

	it('sends chat_left replied when the person wrote and an agent answered during the visit', () => {
		const first = mine()
		const hook = mount([])
		hook.rerender({ messages: [first], isLoaded: true, id: 'c-1' })
		hook.rerender({ messages: [first, agent()], isLoaded: true, id: 'c-1' })

		hook.unmount()

		expect(trackChatLeft).toHaveBeenCalledWith({ entity_id: 'c-1', outcome: 'replied' })
	})

	it('sends chat_left abandoned when the person wrote and left with no answer', () => {
		const hook = mount([])
		hook.rerender({ messages: [mine()], isLoaded: true, id: 'c-1' })

		hook.unmount()

		expect(trackChatLeft).toHaveBeenCalledWith({ entity_id: 'c-1', outcome: 'abandoned' })
	})

	it('sends nothing for a chat the person only read', () => {
		const hook = mount([mine(), agent()])

		hook.unmount()

		expect(trackChatLeft).not.toHaveBeenCalled()
	})

	it('ignores system messages', () => {
		const hook = mount([])
		hook.rerender({ messages: [msg('agent', 'agent-1', 'system')], isLoaded: true, id: 'c-1' })

		hook.unmount()

		expect(trackChatFirstReplyReceived).not.toHaveBeenCalled()
		expect(trackChatLeft).not.toHaveBeenCalled()
	})

	it('sends chat_message_resent when the person writes again within 60 seconds with no answer', () => {
		const first = at(mine(), 0)
		const second = at(mine(), 20)
		const hook = mount([])
		hook.rerender({ messages: [first], isLoaded: true, id: 'c-1' })
		hook.rerender({ messages: [first, second], isLoaded: true, id: 'c-1' })
		hook.rerender({ messages: [first, second], isLoaded: true, id: 'c-1' })

		expect(trackChatMessageResent).toHaveBeenCalledOnce()
		expect(trackChatMessageResent).toHaveBeenCalledWith({
			entity_id: 'c-1',
			seconds_since_previous: 20,
		})
	})

	it('does not call it a re-send when 60 seconds had passed or an agent answered in between', () => {
		const first = at(mine(), 0)
		const late = at(mine(), 90)
		const answered = at(mine(), 40)
		const hook = mount([])
		hook.rerender({ messages: [first], isLoaded: true, id: 'c-1' })
		hook.rerender({ messages: [first, late], isLoaded: true, id: 'c-1' })
		expect(trackChatMessageResent).not.toHaveBeenCalled()

		const other = mount([])
		other.rerender({ messages: [first], isLoaded: true, id: 'c-1' })
		other.rerender({
			messages: [first, at(agent(), 10), answered],
			isLoaded: true,
			id: 'c-1',
		})
		expect(trackChatMessageResent).not.toHaveBeenCalled()
	})

	it('does not count messages that were already in the chat when it was opened', () => {
		const history = [at(mine(), 0), at(mine(), 5)]
		mount(history)

		expect(trackChatMessageResent).not.toHaveBeenCalled()
	})
})
