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

const actorState = vi.hoisted(() => ({
	actor: { id: 'me', name: 'Me', type: 'human' } as { id: string; name: string } | null,
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => actorState.actor }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { useToggleReaction } from '@/hooks/use-message-reactions'
import type { MessageResponse, MessagesListResponse } from '@/lib/api'
import { ApiError, api } from '@/lib/api'
import { queryClient as appQueryClient } from '@/lib/query'
import { queryKeys } from '@/lib/query-keys'
import { VIEWER_READ_ONLY_MESSAGE } from '@/lib/workspace-role'
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

const mineThumb = {
	emoji: '👍',
	count: 1,
	reactedByMe: true,
	actors: [{ actorId: 'me', actorName: 'Me' }],
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

function emojisOf(queryClient: QueryClient, key: readonly unknown[], id: number) {
	return (reactionsOf(queryClient, key, id) ?? []).map((r) => r.emoji)
}

function deferred() {
	let resolve!: () => void
	let reject!: (e: Error) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
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
	actorState.actor = { id: 'me', name: 'Me' }
	vi.mocked(api.conversations.reactToMessage).mockResolvedValue(undefined)
	vi.mocked(api.conversations.unreactToMessage).mockResolvedValue(undefined)
})

describe('useToggleReaction', () => {
	it('adds your reaction at once in the main timeline and in a thread, then calls the API', async () => {
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])
		seed(queryClient, threadKey, [message(1)])

		act(() => result.current.toggle(1, '👍'))

		// At once: the chip is there before the server has answered.
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
		seed(queryClient, mainKey, [message(1, [mineThumb])])

		act(() => result.current.toggle(1, '👍'))

		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
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

		act(() => result.current.toggle(2, '❤️'))

		expect(emojisOf(queryClient, mainKey, 2)).toEqual(['❤️'])
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
		await waitFor(() => expect(api.conversations.reactToMessage).toHaveBeenCalled())
	})

	it('two quick taps on the same emoji mean add then remove, never the same direction twice', async () => {
		const first = deferred()
		vi.mocked(api.conversations.reactToMessage).mockReturnValue(first.promise)
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => {
			result.current.toggle(1, '👍')
			result.current.toggle(1, '👍')
		})

		// Decided from the cache each time: the second tap saw the first one's chip and took it back.
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
		first.resolve()
		await waitFor(() => expect(api.conversations.unreactToMessage).toHaveBeenCalledTimes(1))
		expect(api.conversations.reactToMessage).toHaveBeenCalledTimes(1)
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
	})

	it('sends the calls in the order they were tapped: the second waits for the first', async () => {
		const first = deferred()
		vi.mocked(api.conversations.reactToMessage).mockReturnValue(first.promise)
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => result.current.toggle(1, '👍'))
		await waitFor(() => expect(api.conversations.reactToMessage).toHaveBeenCalledTimes(1))
		act(() => result.current.toggle(1, '👍'))
		// The remove is queued behind the add that has not finished yet.
		await new Promise((r) => setTimeout(r, 30))
		expect(api.conversations.unreactToMessage).not.toHaveBeenCalled()

		first.resolve()
		await waitFor(() => expect(api.conversations.unreactToMessage).toHaveBeenCalledTimes(1))
		const addOrder = vi.mocked(api.conversations.reactToMessage).mock.invocationCallOrder[0] ?? 0
		const removeOrder =
			vi.mocked(api.conversations.unreactToMessage).mock.invocationCallOrder[0] ?? 0
		expect(addOrder).toBeLessThan(removeOrder)
		expect(queryClient.getQueryData(mainKey)).toBeDefined()
	})

	it('shows one toast for a refused call, not a second one from the app-wide handler', async () => {
		vi.mocked(api.conversations.reactToMessage).mockRejectedValue(new Error('boom'))
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: appQueryClient }, children)
		const { result } = renderHook(() => useToggleReaction(conversationId, workspaceId), { wrapper })

		act(() => result.current.toggle(1, '👍'))

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to react'))
		expect(toast.error).toHaveBeenCalledTimes(1)
		appQueryClient.clear()
	})

	it('shows the viewer message once when the server refuses a viewer', async () => {
		vi.mocked(api.conversations.reactToMessage).mockRejectedValue(
			new ApiError(403, 'Viewers have read-only access to this workspace'),
		)
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: appQueryClient }, children)
		const { result } = renderHook(() => useToggleReaction(conversationId, workspaceId), { wrapper })

		act(() => result.current.toggle(1, '👍'))

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(VIEWER_READ_ONLY_MESSAGE, { id: 'viewer-read-only' }),
		)
		expect(toast.error).toHaveBeenCalledTimes(1)
		appQueryClient.clear()
	})

	it('undoes only the refused tap: 👍 refused, then ❤️ stays', async () => {
		const first = deferred()
		vi.mocked(api.conversations.reactToMessage).mockImplementation((_c, _w, _m, emoji) =>
			emoji === '👍' ? first.promise : Promise.resolve(),
		)
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => {
			result.current.toggle(1, '👍')
			result.current.toggle(1, '❤️')
		})
		expect(emojisOf(queryClient, mainKey, 1)).toEqual(['👍', '❤️'])

		first.reject(new Error('boom'))
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to react'))
		// 👍 is gone, ❤️ was not undone with it, and its call still went out.
		await waitFor(() => expect(emojisOf(queryClient, mainKey, 1)).toEqual(['❤️']))
		await waitFor(() =>
			expect(api.conversations.reactToMessage).toHaveBeenCalledWith(
				conversationId,
				workspaceId,
				1,
				'❤️',
			),
		)
	})

	it('a refused add does not undo a later tap that already took the reaction back', async () => {
		const first = deferred()
		vi.mocked(api.conversations.reactToMessage).mockReturnValue(first.promise)
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => {
			result.current.toggle(1, '👍') // add (will be refused)
			result.current.toggle(1, '👍') // remove
		})
		first.reject(new Error('boom'))
		await waitFor(() => expect(toast.error).toHaveBeenCalled())
		await waitFor(() => expect(api.conversations.unreactToMessage).toHaveBeenCalledTimes(1))
		// The last choice was "no reaction", and that is what the chip shows.
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
	})

	it('add, remove, add with the first refused: the chip ends up as the server will hold it', async () => {
		const first = deferred()
		vi.mocked(api.conversations.reactToMessage)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(undefined)
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => {
			result.current.toggle(1, '👍') // add (refused)
			result.current.toggle(1, '👍') // remove
			result.current.toggle(1, '👍') // add
		})
		expect(emojisOf(queryClient, mainKey, 1)).toEqual(['👍'])

		first.reject(new Error('boom'))
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to react'))
		await waitFor(() => expect(api.conversations.reactToMessage).toHaveBeenCalledTimes(2))
		// The last add still goes out and the server ends up holding 👍, so the chip keeps it.
		expect(reactionsOf(queryClient, mainKey, 1)?.[0]).toMatchObject({ reactedByMe: true })
	})

	it('add, remove, add with the last refused: the chip goes back to no reaction', async () => {
		vi.mocked(api.conversations.reactToMessage)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('boom'))
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => {
			result.current.toggle(1, '👍')
			result.current.toggle(1, '👍')
			result.current.toggle(1, '👍')
		})
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to react'))
		// The server still holds nothing after add, remove, refused add.
		await waitFor(() => expect(reactionsOf(queryClient, mainKey, 1)).toEqual([]))
	})

	it('a refused tap leaves changes on other messages alone', async () => {
		const first = deferred()
		vi.mocked(api.conversations.reactToMessage).mockImplementation((_c, _w, messageId) =>
			messageId === 1 ? first.promise : Promise.resolve(),
		)
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1), message(2)])

		act(() => {
			result.current.toggle(1, '👍')
			result.current.toggle(2, '👀')
		})
		first.reject(new Error('boom'))
		await waitFor(() => expect(toast.error).toHaveBeenCalled())
		await waitFor(() => expect(reactionsOf(queryClient, mainKey, 1)).toEqual([]))
		expect(emojisOf(queryClient, mainKey, 2)).toEqual(['👀'])
	})

	it('puts the chip back when the server refuses', async () => {
		vi.mocked(api.conversations.unreactToMessage).mockRejectedValue(new Error('boom'))
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1, [mineThumb])])

		act(() => result.current.toggle(1, '👍'))
		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to react'))
		await waitFor(() =>
			expect(reactionsOf(queryClient, mainKey, 1)?.[0]).toMatchObject({ reactedByMe: true }),
		)
	})

	it('cancels a refetch in flight without turning the query into an error, keeping the chip', async () => {
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])
		const refetch = deferred()
		const stale = {
			pages: [{ messages: [message(1)], has_more: false }],
			pageParams: [undefined],
		}
		// A refetch started before the tap, carrying the page as it was.
		const inFlight = queryClient
			.fetchQuery({
				queryKey: mainKey,
				queryFn: () => refetch.promise.then(() => stale),
				staleTime: 0,
			})
			.catch(() => undefined)

		act(() => result.current.toggle(1, '👍'))
		await inFlight
		// Late data from the cancelled fetch must not land over the chip.
		refetch.resolve()
		await new Promise((r) => setTimeout(r, 30))

		const state = queryClient.getQueryState(mainKey)
		expect(state?.status).toBe('success')
		expect(state?.error).toBeNull()
		expect(state?.fetchStatus).toBe('idle')
		expect(emojisOf(queryClient, mainKey, 1)).toEqual(['👍'])
	})

	it('does not refetch the messages itself: the live message_updated refresh does that', async () => {
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])
		const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

		act(() => result.current.toggle(1, '👍'))
		await waitFor(() => expect(api.conversations.reactToMessage).toHaveBeenCalled())
		await new Promise((r) => setTimeout(r, 30))

		expect(invalidate).not.toHaveBeenCalled()
	})

	it('with no stored person it adds no made-up chip, but still asks the server', async () => {
		actorState.actor = null
		const { queryClient, result } = setup()
		seed(queryClient, mainKey, [message(1)])

		act(() => result.current.toggle(1, '👍'))

		expect(reactionsOf(queryClient, mainKey, 1)).toEqual([])
		await waitFor(() => expect(api.conversations.reactToMessage).toHaveBeenCalledTimes(1))
	})
})
