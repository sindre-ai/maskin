import { type InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			postMessage: vi.fn(),
			messages: vi.fn(),
			markThreadRead: vi.fn(),
		},
	},
}))

import { useMarkThreadRead, useSendMessage, useThreadReplies } from '@/hooks/use-conversation'
import { api } from '@/lib/api'
import type { MessageResponse, MessagesListResponse } from '@/lib/api'
import { isTimelineMessage } from '@/lib/message-threads'
import { queryKeys } from '@/lib/query-keys'

const CONV = 'conv-1'
const WS = 'ws-1'

function message(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id,
		conversationId: CONV,
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

function pages(...messages: MessageResponse[]): InfiniteData<MessagesListResponse> {
	return { pageParams: [undefined], pages: [{ messages, has_more: false }] }
}

function newClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) =>
		React.createElement(QueryClientProvider, { client }, children)
}

const mainKey = queryKeys.conversations.messages(CONV, { limit: 50 })
const threadKey = (root: number) => queryKeys.conversations.threadMessages(CONV, root)

function ids(client: QueryClient, key: readonly unknown[]) {
	return client
		.getQueryData<InfiniteData<MessagesListResponse>>(key)
		?.pages[0]?.messages.map((m) => m.id)
}

function deferred<T>() {
	let resolve: (v: T) => void = () => {}
	let reject: (e: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('useSendMessage — cache routing', () => {
	beforeEach(() => vi.clearAllMocks())

	it('does not enter a thread cache for a top-level send', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(message(1)))
		client.setQueryData(threadKey(1), pages(message(2, { threadRootId: 1 })))
		const gate = deferred<MessageResponse>()
		vi.mocked(api.conversations.postMessage).mockReturnValue(gate.promise)

		const { result } = renderHook(() => useSendMessage(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ content: 'hi' }))

		await waitFor(() => expect(ids(client, mainKey)).toHaveLength(2))
		expect(ids(client, threadKey(1))).toEqual([2])
		gate.resolve(message(10, { actorId: 'me', actorType: 'human' }))
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
	})

	it('puts a reply in the main cache and only in its own thread cache', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(message(1), message(3)))
		client.setQueryData(threadKey(1), pages(message(2, { threadRootId: 1 })))
		client.setQueryData(threadKey(3), pages())
		const gate = deferred<MessageResponse>()
		vi.mocked(api.conversations.postMessage).mockReturnValue(gate.promise)

		const { result } = renderHook(() => useSendMessage(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ content: 'reply', thread_root_id: 1 }))

		await waitFor(() => expect(ids(client, threadKey(1))).toHaveLength(2))
		expect(ids(client, mainKey)).toHaveLength(3)
		expect(ids(client, threadKey(3))).toEqual([])
		gate.resolve(message(10, { threadRootId: 1 }))
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
	})

	it('shows the optimistic reply in the timeline only when it is also sent to the channel', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(message(1)))
		const gate = deferred<MessageResponse>()
		vi.mocked(api.conversations.postMessage).mockReturnValue(gate.promise)

		const { result } = renderHook(() => useSendMessage(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ content: 'quiet', thread_root_id: 1 }))
		await waitFor(() => expect(ids(client, mainKey)).toHaveLength(2))
		const quiet =
			client.getQueryData<InfiniteData<MessagesListResponse>>(mainKey)?.pages[0]?.messages[0]
		expect(quiet && isTimelineMessage(quiet)).toBe(false)

		act(() => result.current.mutate({ content: 'loud', thread_root_id: 1, also_in_channel: true }))
		await waitFor(() => expect(ids(client, mainKey)).toHaveLength(3))
		const loud =
			client.getQueryData<InfiniteData<MessagesListResponse>>(mainKey)?.pages[0]?.messages[0]
		expect(loud?.content).toBe('loud')
		expect(loud && isTimelineMessage(loud)).toBe(true)
		gate.resolve(message(10))
	})

	it('rolls both cache kinds back when the send fails', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(message(1)))
		client.setQueryData(threadKey(1), pages())
		const gate = deferred<MessageResponse>()
		vi.mocked(api.conversations.postMessage).mockReturnValue(gate.promise)

		const { result } = renderHook(() => useSendMessage(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ content: 'oops', thread_root_id: 1 }))
		await waitFor(() => expect(ids(client, threadKey(1))).toHaveLength(1))
		gate.reject(new Error('nope'))
		await waitFor(() => expect(result.current.isError).toBe(true))

		expect(ids(client, mainKey)).toEqual([1])
		expect(ids(client, threadKey(1))).toEqual([])
	})

	it('swaps the temp id for the real row in both cache kinds on success', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(message(1)))
		client.setQueryData(threadKey(1), pages())
		const gate = deferred<MessageResponse>()
		vi.mocked(api.conversations.postMessage).mockReturnValue(gate.promise)

		const { result } = renderHook(() => useSendMessage(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ content: 'sent', thread_root_id: 1 }))
		await waitFor(() => expect(ids(client, threadKey(1))).toHaveLength(1))
		gate.resolve(message(99, { threadRootId: 1 }))
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(ids(client, threadKey(1))).toEqual([99])
		expect(ids(client, mainKey)).toEqual([99, 1])
	})
})

describe('useThreadReplies', () => {
	beforeEach(() => vi.clearAllMocks())

	it('asks for the thread and pages backwards with before_id', async () => {
		vi.mocked(api.conversations.messages)
			.mockResolvedValueOnce({
				messages: [message(9, { threadRootId: 1 }), message(8, { threadRootId: 1 })],
				has_more: true,
			})
			.mockResolvedValueOnce({ messages: [message(7, { threadRootId: 1 })], has_more: false })

		const client = newClient()
		const { result } = renderHook(() => useThreadReplies(CONV, WS, 1), { wrapper: wrapper(client) })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.conversations.messages).toHaveBeenLastCalledWith(
			CONV,
			WS,
			expect.objectContaining({ thread_root_id: '1' }),
		)

		await act(async () => {
			await result.current.fetchNextPage()
		})
		expect(api.conversations.messages).toHaveBeenLastCalledWith(
			CONV,
			WS,
			expect.objectContaining({ thread_root_id: '1', before_id: '8' }),
		)
	})
})

describe('useMarkThreadRead', () => {
	beforeEach(() => vi.clearAllMocks())

	function rootWithThread(unread: number) {
		return message(1, {
			thread: {
				replyCount: 3,
				lastReplyId: 5,
				lastReplyAt: null,
				unreadCount: unread,
				participants: [],
			},
		})
	}

	it('zeroes the pill on the root in main caches and calls the thread-read route', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(rootWithThread(2)))
		const gate = deferred<{ last_read_message_id: number }>()
		vi.mocked(api.conversations.markThreadRead).mockReturnValue(gate.promise)

		const { result } = renderHook(() => useMarkThreadRead(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ rootId: 1, lastReadMessageId: 5 }))

		await waitFor(() => {
			const root =
				client.getQueryData<InfiniteData<MessagesListResponse>>(mainKey)?.pages[0]?.messages[0]
			expect(root?.thread?.unreadCount).toBe(0)
		})
		expect(api.conversations.markThreadRead).toHaveBeenCalledWith(CONV, WS, 1, 5)
		gate.resolve({ last_read_message_id: 5 })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
	})

	it('on settle invalidates the thread list and main caches, never the open thread query', async () => {
		const client = newClient()
		client.setQueryData(mainKey, pages(rootWithThread(2)))
		client.setQueryData(threadKey(1), pages(message(2, { threadRootId: 1 })))
		client.setQueryData(queryKeys.conversations.replyThreads(WS), { threads: [] })
		vi.mocked(api.conversations.markThreadRead).mockResolvedValue({ last_read_message_id: 5 })

		const { result } = renderHook(() => useMarkThreadRead(CONV, WS), { wrapper: wrapper(client) })
		act(() => result.current.mutate({ rootId: 1, lastReadMessageId: 5 }))
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		await waitFor(() => expect(client.getQueryState(mainKey)?.isInvalidated).toBe(true))

		expect(client.getQueryState(queryKeys.conversations.replyThreads(WS))?.isInvalidated).toBe(true)
		expect(client.getQueryState(threadKey(1))?.isInvalidated).toBe(false)
	})
})
