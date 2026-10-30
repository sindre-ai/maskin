import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	type ChatReplyPostedProps,
	chatReplyPath,
	trackChatReplyPosted,
} from '../../../lib/analytics/chat-reply-events'

const base: ChatReplyPostedProps = {
	workspaceId: 'ws-1',
	conversationId: 'conv-1',
	agentId: 'agent-1',
	sessionThreadRootId: 40,
	replyThreadRootId: 40,
	originThreadRootId: 40,
	originMessageId: 42,
	latencyMs: 1800,
	path: 'session',
	source: 'final_output',
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackChatReplyPosted', () => {
	it('emits once, keyed by the agent, with both thread ids and the path', async () => {
		await trackChatReplyPosted(base)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		const [event, distinctId, props] = capturePosthogEventMock.mock.calls[0] ?? []
		expect([event, distinctId]).toEqual(['chat_reply_posted', 'agent-1'])
		expect(props).toMatchObject({
			conversation_id: 'conv-1',
			session_thread_root_id: 40,
			reply_thread_root_id: 40,
			origin_message_id: 42,
			latency_ms: 1800,
			path: 'session',
		})
	})

	it('never rejects when the capture throws', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('posthog down'))

		await expect(trackChatReplyPosted(base)).resolves.toBeUndefined()
	})
})

describe('chatReplyPath', () => {
	it('is session when the session is the one for the message place, main chat included', () => {
		expect(chatReplyPath(40, 40)).toBe('session')
		expect(chatReplyPath(null, null)).toBe('session')
	})

	it('is fallback when a session answers a message from another place', () => {
		expect(chatReplyPath(null, 40)).toBe('fallback')
		expect(chatReplyPath(40, null)).toBe('fallback')
		expect(chatReplyPath(40, 41)).toBe('fallback')
	})
})
