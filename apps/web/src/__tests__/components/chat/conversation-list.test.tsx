import type { ConversationListItemResponse } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: { conversations: { list: vi.fn() } },
}))

import { ConversationList } from '@/components/chat/conversation-list'
import { api } from '@/lib/api'

function buildConversation(
	overrides: Partial<ConversationListItemResponse> = {},
): ConversationListItemResponse {
	return {
		id: 'conv-1',
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
		participants: [],
		...overrides,
	}
}

describe('ConversationList', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.list).mockReset()
	})

	it('renders the group rail and ends the list silently when there is no next page', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [buildConversation({ id: 'a', title: 'Billing retries' })],
			has_more: false,
		})
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Today')).toBeInTheDocument()
		// The last row is the end of the list — no running-total footer under it.
		expect(screen.queryByText(/whole history/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Older conversations load as you scroll/)).not.toBeInTheDocument()
	})

	it('advertises the scroll affordance only while another page is pending', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [buildConversation({ id: 'a' })],
			has_more: true,
		})
		render(<ConversationList workspaceId="ws-1" />, { wrapper: TestWrapper })

		// The sentinel only claims to be loading while a page is actually in
		// flight; idle it advertises the scroll affordance (mockup 545–549).
		expect(await screen.findByText(/Older conversations load as you scroll/)).toBeInTheDocument()
	})

	it('shows the archived-specific empty copy when the archived filter matches nothing', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		render(<ConversationList workspaceId="ws-1" filter="archived" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Nothing archived yet')).toBeInTheDocument()
		// A new chat is never archived, so offering one here sends the reader
		// somewhere this list will still not show it (mockup 542–544).
		expect(screen.queryByRole('link', { name: 'Start a new one →' })).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'View all chats →' })).toBeInTheDocument()
	})

	it('shows the generic empty copy for a filter with no matches', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		render(<ConversationList workspaceId="ws-1" filter="pinned" />, { wrapper: TestWrapper })

		expect(await screen.findByText('No conversations here')).toBeInTheDocument()
	})

	it('sends the matching query param for each filter', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		const { unmount } = render(<ConversationList workspaceId="ws-1" filter="unread" />, {
			wrapper: TestWrapper,
		})
		await waitFor(() =>
			expect(api.conversations.list).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ unread_only: 'true' }),
			),
		)
		unmount()

		vi.mocked(api.conversations.list).mockClear()
		render(<ConversationList workspaceId="ws-1" filter="pinned" />, { wrapper: TestWrapper })
		await waitFor(() =>
			expect(api.conversations.list).toHaveBeenCalledWith(
				'ws-1',
				expect.objectContaining({ pinned: 'true' }),
			),
		)
	})

	it('collapses archived results into a single Archived group', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [
				buildConversation({ id: 'a', archived: true }),
				buildConversation({ id: 'b', archived: true, pinned: true, title: 'Pinned one' }),
			],
			has_more: false,
		})
		render(<ConversationList workspaceId="ws-1" filter="archived" />, { wrapper: TestWrapper })

		expect(await screen.findByText('Archived')).toBeInTheDocument()
		expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
	})
})
