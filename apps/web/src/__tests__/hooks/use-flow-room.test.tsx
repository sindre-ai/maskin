import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))
vi.mock('@/hooks/use-mark-conversation-read', () => ({ useMarkConversationRead: vi.fn() }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			list: vi.fn(),
			create: vi.fn(),
			messages: vi.fn(),
			postMessage: vi.fn(),
		},
	},
}))

import { useFlowRoom } from '@/hooks/use-flow-room'
import { api } from '@/lib/api'
import type { MessageResponse } from '@/lib/api'

function message(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: 'chat-1',
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

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client }, children)
}

const flow = { id: 'flow-1', name: 'Weekly review' }

describe('useFlowRoom', () => {
	let client: QueryClient
	beforeEach(() => {
		vi.clearAllMocks()
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	})

	it('finds the chat by the flow as its subject, then looks among archived ones', async () => {
		vi.mocked(api.conversations.list)
			.mockResolvedValueOnce({ conversations: [], has_more: false })
			.mockResolvedValueOnce({ conversations: [{ id: 'chat-1' } as never], has_more: false })
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [message(2), message(1)],
			has_more: false,
		})

		const { result } = renderHook(
			() => useFlowRoom('ws-1', flow, { agentId: 'agent-1', active: true }),
			{ wrapper: wrapperFor(client) },
		)

		await waitFor(() => expect(result.current.messages).toHaveLength(2))
		expect(api.conversations.list).toHaveBeenNthCalledWith(1, 'ws-1', {
			subject_type: 'object',
			subject_id: 'flow-1',
			limit: '1',
		})
		expect(api.conversations.list).toHaveBeenNthCalledWith(2, 'ws-1', {
			subject_type: 'object',
			subject_id: 'flow-1',
			limit: '1',
			archived: 'true',
		})
		// Oldest first.
		expect(result.current.messages.map((m) => m.id)).toEqual([1, 2])
	})

	it('leaves out a reply that was not sent to the main timeline', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({
			conversations: [{ id: 'chat-1' } as never],
			has_more: false,
		})
		vi.mocked(api.conversations.messages).mockResolvedValue({
			messages: [
				message(3, { threadRootId: 1, threadAlsoInChannel: false }),
				message(2, { threadRootId: 1, threadAlsoInChannel: true }),
				message(1),
			],
			has_more: false,
		})

		const { result } = renderHook(
			() => useFlowRoom('ws-1', flow, { agentId: null, active: false }),
			{ wrapper: wrapperFor(client) },
		)

		await waitFor(() => expect(result.current.messages).toHaveLength(2))
		expect(result.current.messages.map((m) => m.id)).toEqual([1, 2])
	})

	it('makes the chat on the first post, with the driver in it and the tagged people noted', async () => {
		vi.mocked(api.conversations.list).mockResolvedValue({ conversations: [], has_more: false })
		vi.mocked(api.conversations.create).mockResolvedValue({ id: 'chat-9' } as never)
		vi.mocked(api.conversations.postMessage).mockResolvedValue(message(1))
		vi.mocked(api.conversations.messages).mockResolvedValue({ messages: [], has_more: false })

		const { result } = renderHook(
			() => useFlowRoom('ws-1', flow, { agentId: 'agent-1', active: true }),
			{ wrapper: wrapperFor(client) },
		)
		await waitFor(() => expect(result.current.isLoading).toBe(false))

		await act(async () => {
			// Tagging yourself is dropped, as it is in every chat.
			await result.current.post('Hold until the sketch is in', ['agent-2', 'me'])
		})

		expect(api.conversations.create).toHaveBeenCalledWith('ws-1', {
			title: 'Weekly review',
			participant_actor_ids: ['agent-1'],
			subject: { type: 'object', id: 'flow-1' },
		})
		expect(api.conversations.postMessage).toHaveBeenCalledWith('chat-9', 'ws-1', {
			content: 'Hold until the sketch is in',
			metadata: { mentions: ['agent-2'] },
		})
	})
})
