import { type InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: {
		conversations: {
			reactToMessage: vi.fn(),
			unreactToMessage: vi.fn(),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { useToggleReaction } from '@/hooks/use-message-reactions'
import type { MessageResponse, MessagesListResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { toast } from 'sonner'

const conversationId = 'conv-1'
const workspaceId = 'ws-1'

function message(id: number, reactions: MessageResponse['reactions'] = []): MessageResponse {
	return {
		id,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Agent',
		actorType: 'agent',
		kind: 'message',
		content: `message ${id}`,
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: null,
		reactions,
	}
}

function seed(queryClient: QueryClient, key: readonly unknown[], messages: MessageResponse[]) {
	queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
		pages: [{ messages, has_more: false }],
		pageParams: [undefined],
	})
}

function reactionsOf(queryClient: QueryClient, key: readonly unknown[], id: number) {
	const cache = queryClient.getQueryData<InfiniteData<MessagesListResponse>>(key)
	return cache?.pages[0]?.messages.find((m) => m.id === id)?.reactions
}

function setup() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
	})
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: queryClient }, children)
	const { result } = renderHook(() => useToggleReaction(conversationId, workspaceId), { wrapper })
	return { queryClient, result }
}

const mainKey = queryKeys.conversations.messages(conversationId)
const threadKey = queryKeys.conversations.threadMessages(conversationId, 1)

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(api.conversations.reactToMessage).mockResolvedValue(undefined)
	vi.mocked(api.conversations.unreactToMessage).mockResolvedValue(undefined)
})

describe('useToggleReaction', () => {
	it('adds your reaction at once in the main timeline and in a thread, then calls the API', async () => {
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])
		seed(queryClient, threadKey, [message(1)])

		act(() => result.current.mutate({ messageId: 1, emoji: '👍', adding: true }))

		await waitFor(() => expect(reactionsOf(queryClient, mainKey, 1)).toHaveLength(1))
		expect(reactionsOf(queryClient, mainKey, 1)?.[0]).toMatchObject({
			emoji: '👍',
			count: 1,
			reactedByMe: true,
		})
		expect(reactionsOf(queryClient, threadKey, 1)).toHaveLength(1)
		await waitFor(() =>
			expect(api.conversations.reactToMessage).toHaveBeenCalledWith(
				conversationId,
				workspaceId,
				1,
				'👍',
			),
		)
	})

	it('takes your reaction back through the delete call', async () => {
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [
			message(1, [
				{
					emoji: '👍',
					count: 1,
					reactedByMe: true,
					actors: [{ actorId: 'me', actorName: 'Me' }],
				},
			]),
		])

		act(() => result.current.mutate({ messageId: 1, emoji: '👍', adding: false }))

		await waitFor(() => expect(reactionsOf(queryClient, mainKey, 1)).toEqual([]))
		await waitFor(() =>
			expect(api.conversations.unreactToMessage).toHaveBeenCalledWith(
				conversationId,
				workspaceId,
				1,
				'👍',
			),
		)
	})

	it('only touches the message that was reacted to', async () => {
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1), message(2)])

		act(() => result.current.mutate({ messageId: 2, emoji: '❤️', adding: true }))

		await waitFor(() => expect(reactionsOf(queryClient, mainKey, 2)).toHaveLength(1))
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
	})

	it('rolls the chip back and says so when the server refuses', async () => {
		vi.mocked(api.conversations.reactToMessage).mockRejectedValue(new Error('boom'))
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => result.current.mutate({ messageId: 1, emoji: '👍', adding: true }))

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to react'))
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
	})
})
