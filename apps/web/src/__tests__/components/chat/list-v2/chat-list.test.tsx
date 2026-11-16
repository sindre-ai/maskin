import type { ConversationListItemResponse } from '@/lib/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			list: vi.fn(),
			replyThreads: vi.fn(),
			messages: vi.fn(),
			updateMe: vi.fn(),
			retryMessage: vi.fn(),
		},
		search: { query: vi.fn() },
	},
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

const { trackOpened } = vi.hoisted(() => ({ trackOpened: vi.fn() }))
vi.mock('@/lib/analytics', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/analytics')>()),
	trackChatOpenedFromList: trackOpened,
}))

import { ChatListV2 } from '@/components/chat/list-v2/chat-list'
import { api } from '@/lib/api'

function chat(overrides: Partial<ConversationListItemResponse> = {}): ConversationListItemResponse {
	return {
		id: 'c1',
		workspaceId: 'ws-1',
		title: 'Billing retries',
		createdBy: 'me',
		lastMessageAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: null,
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: 'Still open on three accounts.',
		snippet_actor_id: null,
		snippet_actor_name: null,
		working_actor_ids: [],
		participants: [
			{ actorId: 'me', actorName: 'Me', actorType: 'human', joinedAt: null, addedBy: null },
			{ actorId: 'a1', actorName: 'Forge', actorType: 'agent', joinedAt: null, addedBy: null },
		],
		...overrides,
	}
}

/** The default list answers priority and recent; the Later fetch asks for later=true. */
function mockList({
	priority = [],
	recent = [],
	later = [],
}: {
	priority?: ConversationListItemResponse[]
	recent?: ConversationListItemResponse[]
	later?: ConversationListItemResponse[]
}) {
	vi.mocked(api.conversations.list).mockImplementation(async (_ws, params) => {
		if (params?.later === 'true') return { conversations: later, has_more: false }
		if (params?.scope === 'priority') return { conversations: priority, has_more: false }
		return { conversations: recent, has_more: false }
	})
}

function renderList(props: Partial<React.ComponentProps<typeof ChatListV2>> = {}) {
	return render(
		<ChatListV2
			workspaceId="ws-1"
			pill="all"
			onPillChange={vi.fn()}
			groupBy="date"
			query=""
			{...props}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('ChatListV2', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.list).mockReset()
		vi.mocked(api.conversations.replyThreads).mockReset()
		vi.mocked(api.conversations.replyThreads).mockResolvedValue({ threads: [] } as never)
		trackOpened.mockReset()
	})

	it('groups by day with no counts in the headings', async () => {
		mockList({ recent: [chat({ id: 'a' }), chat({ id: 'b', title: 'Second' })] })
		renderList()
		expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Today' }).textContent).toBe('Today')
	})

	it('shows the six skeleton rows and pills without counts while loading', () => {
		vi.mocked(api.conversations.list).mockReturnValue(new Promise(() => {}))
		renderList()
		expect(screen.getByLabelText('Loading chats').children).toHaveLength(6)
		expect(screen.getByRole('button', { name: 'Needs you' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Needs you' }).textContent).toBe('Needs you')
	})

	it('counts the inactive pills and counts a stopped chat under Needs you', async () => {
		mockList({
			priority: [
				chat({ id: 'ask', needs_you: true }),
				chat({ id: 'stopped', error: { reason: 'other', message_id: 1 } }),
			],
			recent: [chat({ id: 'new', unread_count: 1 }), chat({ id: 'quiet' })],
			later: [chat({ id: 'l', later: true })],
		})
		renderList()
		await screen.findByRole('heading', { name: 'Today' })
		expect(screen.getByRole('button', { name: /Needs you/ }).textContent).toBe('Needs you2')
		expect(screen.getByRole('button', { name: /Unread/ }).textContent).toBe('Unread1')
		expect(screen.getByRole('button', { name: /Later/ }).textContent).toBe('Later1')
		expect(screen.getByRole('button', { name: 'All' }).textContent).toBe('All')
	})

	it('lists only the chats that wait on the person under Needs you', async () => {
		mockList({
			priority: [chat({ id: 'ask', title: 'Needs an answer', needs_you: true })],
			recent: [chat({ id: 'quiet', title: 'Quiet chat' })],
		})
		renderList({ pill: 'needs_you' })
		expect(await screen.findByText('Needs an answer')).toBeInTheDocument()
		expect(screen.queryByText('Quiet chat')).not.toBeInTheDocument()
	})

	it('keeps a Later chat out of All and shows it under Later', async () => {
		mockList({
			recent: [
				chat({ id: 'a', title: 'Visible' }),
				chat({ id: 'l', title: 'Parked', later: true }),
			],
			later: [chat({ id: 'l', title: 'Parked', later: true })],
		})
		const { unmount } = renderList()
		expect(await screen.findByText('Visible')).toBeInTheDocument()
		expect(screen.queryByText('Parked')).not.toBeInTheDocument()
		unmount()
		renderList({ pill: 'later' })
		expect(await screen.findByText('Parked')).toBeInTheDocument()
		expect(screen.queryByText('Visible')).not.toBeInTheDocument()
	})

	it.each([
		['all', 'No chats yet. Start one with an agent.'],
		['needs_you', 'Nothing waits on you.'],
		['unread', 'You are all caught up.'],
		['working', 'No agent is working right now.'],
		['later', 'Nothing is on Later. Move a chat here to hide it until it gets a new message.'],
	] as const)('says "%s" is empty in the addendum words', async (pill, copy) => {
		mockList({})
		renderList({ pill })
		expect(await screen.findByText(copy)).toBeInTheDocument()
	})

	it('says the list did not load and retries from the button', async () => {
		const user = userEvent.setup()
		vi.mocked(api.conversations.list).mockRejectedValue(new Error('boom'))
		renderList()
		expect(await screen.findByText('Chats did not load.')).toBeInTheDocument()
		mockList({ recent: [chat({ title: 'Back again' })] })
		await user.click(screen.getByRole('button', { name: 'Retry' }))
		expect(await screen.findByText('Back again')).toBeInTheDocument()
	})

	it('reports the marker, filter and group_by when a row is opened', async () => {
		const user = userEvent.setup()
		mockList({ priority: [chat({ id: 'ask', needs_you: true })] })
		renderList({ pill: 'needs_you', groupBy: 'status' })
		await user.click(
			await screen.findByTestId('chat-row').then((row) => within(row).getByRole('link')),
		)
		await waitFor(() => expect(trackOpened).toHaveBeenCalled())
		expect(trackOpened).toHaveBeenCalledWith({
			source: 'list',
			section: 'needs_you',
			position: 1,
			marker: 'needs_you',
			filter: 'needs_you',
			group_by: 'status',
		})
	})
})
