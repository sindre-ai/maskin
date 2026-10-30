import type { MessageResponse, ReplyThreadListItem } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../../setup'

// The shared router mock drops `params` and `search`; this one shows where each link goes.
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return {
		...mockTanStackRouter(),
		Link: ({
			children,
			to,
			params,
			search,
		}: {
			children: React.ReactNode
			to: string
			params: Record<string, string>
			search: Record<string, unknown>
		}) => (
			<a href={to} data-params={JSON.stringify(params)} data-search={JSON.stringify(search)}>
				{children}
			</a>
		),
	}
})

vi.mock('@/lib/api', () => ({
	api: { conversations: { replyThreads: vi.fn() } },
}))

import { ConversationList } from '@/components/chat/conversation-list'
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

function item(overrides: Partial<ReplyThreadListItem> = {}): ReplyThreadListItem {
	return {
		conversationId: 'conv-1',
		conversationTitle: 'Billing retries',
		root: message(1, { content: 'the root' }),
		thread: {
			replyCount: 2,
			lastReplyId: 3,
			lastReplyAt: null,
			unreadCount: 0,
			participants: [],
		},
		lastReply: message(3, { actorName: 'Sam', content: 'the last reply' }),
		...overrides,
	}
}

describe('ConversationList — Threads filter', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.replyThreads).mockReset()
	})

	it('lists threads with their chat, root, reply count and latest reply', async () => {
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [item()] })
		render(<ConversationList workspaceId="ws-1" filter="threads" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Billing retries')).toBeInTheDocument()
		expect(screen.getByText(/the root/)).toBeInTheDocument()
		expect(screen.getByText(/2 replies · Sam: the last reply/)).toBeInTheDocument()
	})

	it('marks a thread with unread replies and links to it in its chat', async () => {
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({
			threads: [item({ thread: { ...item().thread, unreadCount: 2 } })],
		})
		render(<ConversationList workspaceId="ws-1" filter="threads" />, { wrapper: TestWrapper })

		expect(await screen.findByLabelText('2 unread')).toBeInTheDocument()
		const link = screen.getByRole('link')
		expect(link).toHaveAttribute(
			'data-params',
			JSON.stringify({ workspaceId: 'ws-1', conversationId: 'conv-1' }),
		)
		expect(link).toHaveAttribute('data-search', JSON.stringify({ thread: 1 }))
	})

	it('says there are no threads yet when the list is empty', async () => {
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [] })
		render(<ConversationList workspaceId="ws-1" filter="threads" />, { wrapper: TestWrapper })

		expect(await screen.findByText('No threads yet')).toBeInTheDocument()
	})

	it('does not say the chats are lost when the threads fail to load', async () => {
		vi.mocked(api.conversations.replyThreads).mockRejectedValue(new Error('boom'))
		render(<ConversationList workspaceId="ws-1" filter="threads" />, { wrapper: TestWrapper })

		expect(await screen.findByText("Couldn't load your threads")).toBeInTheDocument()
	})
})
