import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			get: vi.fn(),
			messages: vi.fn(),
			updateMe: vi.fn(),
		},
	},
}))

import { useMarkConversationRead } from '@/hooks/use-mark-conversation-read'
import { api } from '@/lib/api'
import type { MessageResponse } from '@/lib/api'

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
		sessionId: null,
		createdAt: null,
		editedAt: null,
		...overrides,
	}
}

describe('useMarkConversationRead', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.conversations.updateMe).mockResolvedValue({} as never)
	})

	it('advances the read cursor to a newest message that is a thread reply', async () => {
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: 3,
		} as never)
		// Newest-first: the reply (7) is newer than the last top-level message (5) and is not
		// shown in the timeline, but the conversation's unread count includes it.
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [message(7, { threadRootId: 5, threadAlsoInChannel: false }), message(5)],
			has_more: false,
		})
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const wrapper = ({ children }: { children: ReactNode }) =>
			React.createElement(QueryClientProvider, { client }, children)

		renderHook(() => useMarkConversationRead('conv-1', 'ws-1'), { wrapper })

		await waitFor(() =>
			expect(api.conversations.updateMe).toHaveBeenCalledWith('conv-1', 'ws-1', {
				last_read_message_id: 7,
			}),
		)
	})
})
