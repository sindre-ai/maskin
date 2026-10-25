import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			get: vi.fn(),
			messages: vi.fn(),
		},
	},
}))

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ isSuccess: false }) }))

vi.mock('@/components/chat/needed-tools', () => ({ NeededTools: () => null }))

// Spy on what the activity hook is given; its own behaviour has its own tests.
const activityInput = vi.hoisted(() => ({
	messages: [] as Array<{ id: number }>,
	fallback: [] as Array<{ sessionId: string }>,
}))
vi.mock('@/hooks/use-conversation-activity', () => ({
	useConversationActivity: (_ws: string, _conv: string, messages: Array<{ id: number }>) => {
		activityInput.messages = messages
		return {
			byReplyMessageId: new Map(),
			byTriggerMessageId: new Map(),
			fallback: activityInput.fallback,
		}
	},
}))
vi.mock('@/components/chat/message-activity', () => ({
	MessageActivity: () => <div>waiting for the agent</div>,
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

function message(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Forge',
		actorType: 'agent',
		kind: 'message',
		content: `message ${id}`,
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date(2026, 0, 1, 0, 0, id).toISOString(),
		...overrides,
	}
}

function reply(id: number, rootId: number, overrides: Partial<MessageResponse> = {}) {
	return message(id, { threadRootId: rootId, threadAlsoInChannel: false, ...overrides })
}

function mockPage(newestFirst: MessageResponse[], hasMore = false) {
	vi.mocked(api.conversations.messages).mockResolvedValue({
		messages: newestFirst,
		has_more: hasMore,
	} as never)
}

describe('ThreadMessages — reply threads', () => {
	beforeEach(() => {
		activityInput.messages = []
		activityInput.fallback = []
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	it('keeps replies out of the timeline but keeps also-in-channel replies', async () => {
		mockPage([
			reply(4, 1, { content: 'also in channel', threadAlsoInChannel: true }),
			reply(3, 1, { content: 'only in the thread' }),
			message(2, { content: 'later top-level' }),
			message(1, { content: 'the root' }),
		])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('the root')).toBeInTheDocument()
		expect(screen.getByText('later top-level')).toBeInTheDocument()
		expect(screen.getByText('also in channel')).toBeInTheDocument()
		expect(screen.queryByText('only in the thread')).not.toBeInTheDocument()
	})

	it('keeps an untagged turn out of the main chat when the newest message is a thread reply', async () => {
		activityInput.fallback = [{ sessionId: 's1' }]
		mockPage([reply(3, 1), message(1)])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })

		await screen.findByText('message 1')
		expect(screen.queryByText('waiting for the agent')).not.toBeInTheDocument()
	})

	it('still shows an untagged turn in the main chat when the newest message is top-level', async () => {
		activityInput.fallback = [{ sessionId: 's1' }]
		mockPage([message(2), message(1)])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('waiting for the agent')).toBeInTheDocument()
	})

	it('hands the activity hook the unfiltered list, replies included', async () => {
		mockPage([reply(3, 1), message(1)])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })

		await screen.findByText('message 1')
		expect(activityInput.messages.map((m) => m.id)).toEqual([1, 3])
	})

	it('draws a pill under a root with replies and opens its thread', async () => {
		mockPage([
			message(1, {
				thread: {
					replyCount: 2,
					lastReplyId: 3,
					lastReplyAt: null,
					unreadCount: 1,
					participants: [{ actorId: 'agent-1', actorName: 'Forge', actorType: 'agent' }],
				},
			}),
		])
		const onOpenReplies = vi.fn()
		render(
			<ThreadMessages workspaceId="ws-1" conversationId="conv-1" onOpenReplies={onOpenReplies} />,
			{
				wrapper: TestWrapper,
			},
		)

		await userEvent.click(await screen.findByRole('button', { name: '1 new reply. Open thread' }))
		expect(onOpenReplies).toHaveBeenCalledWith(1)
	})

	it('opens the root thread from the Reply action of an also-in-channel reply', async () => {
		mockPage([reply(4, 1, { content: 'also in channel', threadAlsoInChannel: true }), message(1)])
		const onOpenReplies = vi.fn()
		render(
			<ThreadMessages workspaceId="ws-1" conversationId="conv-1" onOpenReplies={onOpenReplies} />,
			{
				wrapper: TestWrapper,
			},
		)

		const buttons = await screen.findAllByRole('button', { name: 'Reply in thread' })
		// Newest-last in the timeline: the also-in-channel reply is the second row.
		await userEvent.click(buttons[1] as HTMLElement)
		expect(onOpenReplies).toHaveBeenCalledWith(1)
	})

	it('does not call a page of only replies an empty chat when older pages exist', async () => {
		mockPage([reply(9, 1), reply(8, 1)], true)
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })

		expect(await screen.findByRole('button', { name: /Load older messages/ })).toBeInTheDocument()
		expect(screen.queryByText('No messages yet')).not.toBeInTheDocument()
	})

	it('still shows the empty state for a chat with no messages at all', async () => {
		mockPage([])
		render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })
		expect(await screen.findByText('No messages yet')).toBeInTheDocument()
	})

	it('keeps the intro steps when the only later human message is a hidden reply', async () => {
		const intro = message(1, {
			content: 'Hey, I am Forge.\n\nStart with one of these.\n\n1. Read my inbox',
			metadata: {
				delivery: { kind: 'agent_intro', version: 1 },
				suggested_steps: [{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' }],
				plain_tail: 1,
			} as never,
		})
		mockPage([
			reply(2, 1, {
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: 'quiet human reply',
			}),
			intro,
		])
		render(
			<ThreadMessages
				workspaceId="ws-1"
				conversationId="conv-1"
				onPickStep={vi.fn()}
				onSendStep={vi.fn()}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(await screen.findByRole('button', { name: /Read my inbox/ })).toBeInTheDocument()
		expect(screen.queryByText('quiet human reply')).not.toBeInTheDocument()
	})
})
