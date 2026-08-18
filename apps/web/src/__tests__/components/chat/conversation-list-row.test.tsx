import type { ConversationListItemResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

import { ConversationListRow } from '@/components/chat/conversation-list-row'

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
		snippet: 'The retry window is still open on three accounts.',
		participants: [
			{
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				joinedAt: null,
				addedBy: null,
			},
			{
				actorId: 'agent-1',
				actorName: 'Billing Agent',
				actorType: 'agent',
				joinedAt: null,
				addedBy: null,
			},
		],
		...overrides,
	}
}

function renderRow(conversation: ConversationListItemResponse) {
	return render(<ConversationListRow workspaceId="ws-1" conversation={conversation} />, {
		wrapper: TestWrapper,
	})
}

describe('ConversationListRow', () => {
	it('renders a single lead avatar for the first participant who is not the viewer', () => {
		renderRow(buildConversation())
		// Two participants, one of them the viewer — exactly one avatar renders.
		expect(screen.getByText('BA')).toBeInTheDocument()
		expect(screen.queryByText('ME')).not.toBeInTheDocument()
	})

	it('renders the unread dot only when there are unread messages', () => {
		const { unmount } = renderRow(buildConversation({ unread_count: 3 }))
		expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
		unmount()

		renderRow(buildConversation({ unread_count: 0 }))
		expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument()
	})

	it('bolds the title while unread and leaves it medium once read', () => {
		const { unmount } = renderRow(buildConversation({ unread_count: 1 }))
		expect(screen.getByText('Billing retries').className).toContain('font-bold')
		unmount()

		renderRow(buildConversation({ unread_count: 0 }))
		expect(screen.getByText('Billing retries').className).toContain('font-medium')
	})

	it('clamps the snippet to two lines', () => {
		renderRow(buildConversation())
		expect(
			screen.getByText('The retry window is still open on three accounts.').className,
		).toContain('line-clamp-2')
	})

	it('marks a pinned conversation and leaves an unpinned one unmarked', () => {
		const { unmount } = renderRow(buildConversation({ pinned: true }))
		expect(screen.getByLabelText('Pinned')).toBeInTheDocument()
		unmount()

		renderRow(buildConversation({ pinned: false }))
		expect(screen.queryByLabelText('Pinned')).not.toBeInTheDocument()
	})

	it('falls back to a placeholder when the conversation has no messages', () => {
		renderRow(buildConversation({ snippet: null }))
		expect(screen.getByText('No messages yet')).toBeInTheDocument()
	})
})
