import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			conversations: {
				get: vi.fn(),
				messages: vi.fn(),
				replyThreads: vi.fn(),
				markThreadRead: vi.fn(),
				postMessage: vi.fn(),
			},
		},
	}
})

vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useActors: () => ({ data: [], isSuccess: true }),
}))
vi.mock('@/hooks/use-sessions', () => ({
	useActiveSessionsForConversation: () => ({ data: [] }),
}))
vi.mock('@/hooks/use-conversation-activity', () => ({
	useConversationActivity: () => ({
		byReplyMessageId: new Map(),
		byTriggerMessageId: new Map(),
		fallback: [],
	}),
}))

import { MessageThreadPane } from '@/components/chat/replies/message-thread-pane'
import type { MessageResponse } from '@/lib/api'
import { ApiError, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { WorkspaceContext } from '@/lib/workspace-context'
import { buildWorkspaceWithRole } from '../../../factories'

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

const reply = (id: number, overrides: Partial<MessageResponse> = {}) =>
	message(id, { threadRootId: 1, threadAlsoInChannel: false, ...overrides })

const agentRoot = () =>
	message(1, {
		content: 'the root',
		thread: {
			replyCount: 2,
			lastReplyId: 3,
			lastReplyAt: null,
			unreadCount: 2,
			participants: [{ actorId: 'agent-1', actorName: 'Forge', actorType: 'agent' }],
		},
	})

function setup({
	main = [agentRoot()],
	replies = [reply(3), reply(2)],
	hasMore = false,
	markRead = () => Promise.resolve({ last_read_message_id: 3 }),
}: {
	main?: MessageResponse[]
	replies?: MessageResponse[]
	hasMore?: boolean
	markRead?: () => Promise<{ last_read_message_id: number }>
} = {}) {
	vi.mocked(api.conversations.get).mockResolvedValue({
		id: 'conv-1',
		participants: [],
		last_read_message_id: null,
	} as never)
	vi.mocked(api.conversations.messages).mockImplementation((async (
		_id: string,
		_ws: string,
		params?: Record<string, string>,
	) =>
		params?.thread_root_id
			? { messages: replies, has_more: hasMore }
			: { messages: main, has_more: false }) as never)
	vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [] })
	vi.mocked(api.conversations.markThreadRead).mockImplementation(markRead)
	vi.mocked(api.conversations.postMessage).mockResolvedValue(reply(10) as never)
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	const ctx = {
		workspace: buildWorkspaceWithRole({ id: 'ws-1' }),
		workspaceId: 'ws-1',
		sseStatus: 'connected' as const,
	}
	const wrapper = ({ children }: { children: ReactNode }) =>
		React.createElement(
			QueryClientProvider,
			{ client },
			React.createElement(WorkspaceContext.Provider, { value: ctx }, children),
		)
	const onClose = vi.fn()
	render(
		<MessageThreadPane workspaceId="ws-1" conversationId="conv-1" rootId={1} onClose={onClose} />,
		{ wrapper },
	)
	return { client, onClose }
}

describe('MessageThreadPane', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		sessionStorage.clear()
	})

	it('shows the root and its replies oldest first under a reply count', async () => {
		setup()
		expect(await screen.findByText('the root')).toBeInTheDocument()
		expect(await screen.findByText('message 2')).toBeInTheDocument()
		expect(screen.getByText('2 replies')).toBeInTheDocument()
		const text = document.body.textContent ?? ''
		expect(text.indexOf('message 2')).toBeLessThan(text.indexOf('message 3'))
	})

	it('marks the thread read up to the newest reply on open and again as replies arrive', async () => {
		const { client } = setup()
		await waitFor(() =>
			expect(api.conversations.markThreadRead).toHaveBeenCalledWith('conv-1', 'ws-1', 1, 3),
		)

		act(() => {
			client.setQueryData(queryKeys.conversations.threadMessages('conv-1', 1), {
				pageParams: [undefined],
				pages: [{ messages: [reply(5), reply(3), reply(2)], has_more: false }],
			})
		})
		await waitFor(() =>
			expect(api.conversations.markThreadRead).toHaveBeenLastCalledWith('conv-1', 'ws-1', 1, 5),
		)
		expect(api.conversations.markThreadRead).toHaveBeenCalledTimes(2)
	})

	it('posts a reply under the root, addressed to the agent, and clears the also-in-chat box', async () => {
		const user = userEvent.setup()
		setup()
		const box = await screen.findByLabelText('Reply in thread')
		await waitFor(() => expect(box).toHaveAttribute('placeholder', 'Reply to Forge…'))

		const checkbox = screen.getByRole('checkbox', { name: 'Also send to chat' })
		await user.click(checkbox)
		expect(checkbox).toBeChecked()
		await user.type(box, 'thanks')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() =>
			expect(api.conversations.postMessage).toHaveBeenCalledWith(
				'conv-1',
				'ws-1',
				expect.objectContaining({
					content: 'thanks',
					thread_root_id: 1,
					also_in_channel: true,
					metadata: { mentions: ['agent-1'] },
				}),
			),
		)
		await waitFor(() => expect(checkbox).not.toBeChecked())
	})

	it('seeds no recipient when a person started the thread and no agent is in it', async () => {
		setup({
			main: [
				message(1, {
					actorId: 'human-2',
					actorName: 'Ada',
					actorType: 'human',
					content: 'the root',
				}),
			],
			replies: [],
		})
		const box = await screen.findByLabelText('Reply in thread')
		expect(box).toHaveAttribute('placeholder', 'Reply…')
		expect(await screen.findByText('No replies yet')).toBeInTheDocument()
	})

	it('finds a root older than the loaded pages through the thread list', async () => {
		setup({ main: [] })
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({
			threads: [
				{
					conversationId: 'conv-1',
					conversationTitle: 'Chat',
					root: message(1, { content: 'an old root' }),
					thread: agentRoot().thread as never,
					lastReply: null,
				},
			],
		})
		expect(await screen.findByText('an old root')).toBeInTheDocument()
	})

	it('says the thread could not be found, and Close leaves it', async () => {
		const user = userEvent.setup()
		const { onClose } = setup({ main: [] })
		expect(await screen.findByText("This thread couldn't be found")).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Close' }))
		expect(onClose).toHaveBeenCalled()
	})

	it('treats a 404 from the read route as not found', async () => {
		setup({ markRead: () => Promise.reject(new ApiError(404, 'Thread not found')) })
		expect(await screen.findByText("This thread couldn't be found")).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		const { onClose } = setup()
		await screen.findByText('the root')
		await user.click(screen.getByLabelText('Reply in thread'))
		await user.keyboard('{Escape}')
		expect(onClose).toHaveBeenCalled()
	})

	it('labels the divider with the thread total, not the replies loaded so far', async () => {
		const root = agentRoot()
		setup({
			main: [
				{
					...root,
					thread: { ...(root.thread as NonNullable<typeof root.thread>), replyCount: 120 },
				},
			],
			hasMore: true,
		})
		expect(await screen.findByText('120 replies')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Load earlier replies' })).toBeInTheDocument()
	})

	it('keeps the pane open when Escape closes a picker', async () => {
		const user = userEvent.setup()
		const { onClose } = setup()
		const box = await screen.findByLabelText('Reply in thread')
		await user.click(box)
		await user.type(box, '@')
		await user.keyboard('{Escape}')
		expect(onClose).not.toHaveBeenCalled()
	})
})
