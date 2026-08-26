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
		snippet_actor_id: null,
		snippet_actor_name: null,
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
	it('plates who the conversation is with, never the viewer', () => {
		renderRow(buildConversation())
		// Two participants, one of them the viewer — only the counterpart plates.
		expect(screen.getByText('BA')).toBeInTheDocument()
		expect(screen.queryByText('ME')).not.toBeInTheDocument()
	})

	it('stacks up to two counterparts and counts the rest', () => {
		renderRow(
			buildConversation({
				participants: [
					{ actorId: 'me', actorName: 'Me', actorType: 'human', joinedAt: null, addedBy: null },
					{
						actorId: 'a',
						actorName: 'Billing Agent',
						actorType: 'agent',
						joinedAt: null,
						addedBy: null,
					},
					{ actorId: 'b', actorName: 'Relay', actorType: 'agent', joinedAt: null, addedBy: null },
					{ actorId: 'c', actorName: 'Quill', actorType: 'agent', joinedAt: null, addedBy: null },
					{ actorId: 'd', actorName: 'Compass', actorType: 'agent', joinedAt: null, addedBy: null },
				],
			}),
		)
		expect(screen.getByText('BA')).toBeInTheDocument()
		expect(screen.getByText('RE')).toBeInTheDocument()
		// Four counterparts plus the viewer, two plated: Quill, Compass and Me.
		expect(screen.getByText('+3')).toBeInTheDocument()
		expect(screen.queryByText('QU')).not.toBeInTheDocument()
	})

	it('plates the only participant in a thread the viewer is alone in', () => {
		renderRow(
			buildConversation({
				participants: [
					{ actorId: 'me', actorName: 'Me', actorType: 'human', joinedAt: null, addedBy: null },
				],
			}),
		)
		expect(screen.getByText('ME')).toBeInTheDocument()
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

	it('leaves pinned state to the group rail rather than marking the row twice', () => {
		// A pinned row only ever appears under the PINNED heading, so a per-row
		// glyph repeated what the group already said (mockup 276–297).
		renderRow(buildConversation({ pinned: true }))
		expect(screen.queryByLabelText('Pinned')).not.toBeInTheDocument()
	})

	it('attributes the snippet to whoever wrote it, and to "You" when that is the viewer', () => {
		const { unmount } = renderRow(
			buildConversation({ snippet_actor_id: 'agent-1', snippet_actor_name: 'Billing Agent' }),
		)
		expect(screen.getByText('Billing Agent:')).toBeInTheDocument()
		unmount()

		renderRow(buildConversation({ snippet_actor_id: 'me', snippet_actor_name: 'Me' }))
		expect(screen.getByText('You:')).toBeInTheDocument()
	})

	it('falls back to a placeholder when the conversation has no messages', () => {
		renderRow(buildConversation({ snippet: null }))
		expect(screen.getByText('No messages yet')).toBeInTheDocument()
	})
})
