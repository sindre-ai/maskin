import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import type { MessageResponse, MessagesListResponse, PostMessageInput } from '../lib/api'
import { api } from '../lib/api'
import { getStoredActor } from '../lib/auth'
import { queryKeys } from '../lib/query-keys'

const MESSAGES_PAGE_SIZE = 50

export function useConversation(id: string, workspaceId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.conversations.detail(id),
		queryFn: () => api.conversations.get(id, workspaceId),
		enabled: !!id && !!workspaceId && (options?.enabled ?? true),
	})
}

/**
 * Newest-first pages from the server — each page's `messages` array runs
 * newest→oldest, and subsequent pages page further into the past via
 * `before_id`. Flatten + reverse (see `flattenMessagesOldestFirst`) to render
 * top(oldest)→bottom(newest) in the thread.
 */
export function useConversationMessages(
	id: string,
	workspaceId: string,
	options?: { enabled?: boolean },
) {
	return useInfiniteQuery({
		queryKey: queryKeys.conversations.messages(id, { limit: MESSAGES_PAGE_SIZE }),
		queryFn: ({ pageParam }) => {
			const params: Record<string, string> = { limit: String(MESSAGES_PAGE_SIZE) }
			if (pageParam) params.before_id = String(pageParam)
			return api.conversations.messages(id, workspaceId, params)
		},
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (lastPage) => {
			if (!lastPage.has_more || lastPage.messages.length === 0) return undefined
			return lastPage.messages[lastPage.messages.length - 1]?.id
		},
		enabled: !!id && !!workspaceId && (options?.enabled ?? true),
	})
}

export function flattenMessagesOldestFirst(
	data: InfiniteData<MessagesListResponse> | undefined,
): MessageResponse[] {
	if (!data) return []
	return data.pages.flatMap((page) => page.messages).reverse()
}

let tempMessageSeq = -1

interface SendMessageContext {
	tempId: number
	snapshots: Array<[readonly unknown[], InfiniteData<MessagesListResponse> | undefined]>
}

// Optimistically prepends the outgoing message to the newest page (page 0 —
// pages run newest-first) so the sender sees it immediately; reconciled with
// the real row on success or dropped on error. Mirrors useUpdateObject's
// optimistic-update-with-rollback recipe.
export function useSendMessage(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<MessageResponse, Error, PostMessageInput, SendMessageContext>({
		mutationFn: (data) => api.conversations.postMessage(id, workspaceId, data),
		onMutate: async (data) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.conversations.messagesPrefix(id) })
			const actor = getStoredActor()
			const tempId = tempMessageSeq--
			const optimisticMessage: MessageResponse = {
				id: tempId,
				conversationId: id,
				actorId: actor?.id ?? '',
				actorName: actor?.name ?? 'You',
				actorType: 'human',
				kind: 'message',
				content: data.content,
				metadata: data.metadata ?? null,
				sessionId: data.session_id ?? null,
				createdAt: new Date().toISOString(),
				editedAt: null,
			}
			const snapshots = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			for (const [key, cache] of snapshots) {
				if (!cache || cache.pages.length === 0) continue
				const [first, ...rest] = cache.pages
				if (!first) continue
				queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
					...cache,
					pages: [{ ...first, messages: [optimisticMessage, ...first.messages] }, ...rest],
				})
			}
			return { tempId, snapshots }
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return
			for (const [key, cache] of ctx.snapshots) queryClient.setQueryData(key, cache)
			toast.error('Failed to send message')
		},
		onSuccess: (message, _vars, ctx) => {
			const snapshots = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			for (const [key, cache] of snapshots) {
				if (!cache) continue
				queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
					...cache,
					pages: cache.pages.map((page) => ({
						...page,
						messages: page.messages.map((m) => (m.id === ctx.tempId ? message : m)),
					})),
				})
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
		},
	})
}

interface EditMessageContext {
	snapshots: Array<[readonly unknown[], InfiniteData<MessagesListResponse> | undefined]>
}

// Optimistically rewrites the message's content in every cached page and marks
// it edited; rolled back on error, reconciled with the server row on success.
export function useEditMessage(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<
		MessageResponse,
		Error,
		{ messageId: number; content: string },
		EditMessageContext
	>({
		mutationFn: ({ messageId, content }) =>
			api.conversations.editMessage(id, workspaceId, messageId, { content }),
		onMutate: async ({ messageId, content }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.conversations.messagesPrefix(id) })
			const snapshots = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			for (const [key, cache] of snapshots) {
				if (!cache) continue
				queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
					...cache,
					pages: cache.pages.map((page) => ({
						...page,
						messages: page.messages.map((m) =>
							m.id === messageId ? { ...m, content, editedAt: new Date().toISOString() } : m,
						),
					})),
				})
			}
			return { snapshots }
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return
			for (const [key, cache] of ctx.snapshots) queryClient.setQueryData(key, cache)
			toast.error('Failed to edit message')
		},
		onSuccess: (message) => {
			const snapshots = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			for (const [key, cache] of snapshots) {
				if (!cache) continue
				queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
					...cache,
					pages: cache.pages.map((page) => ({
						...page,
						messages: page.messages.map((m) => (m.id === message.id ? message : m)),
					})),
				})
			}
		},
	})
}

// Asks the backend to re-run the agent responder for a message — used when an
// agent never replied (boot failure, declined relevance) or the user wants a
// fresh answer. Fire-and-forget on the server; feedback here is just a toast.
export function useRetryMessage(id: string, workspaceId: string) {
	return useMutation<{ retried: boolean }, Error, { messageId: number; agentId?: string }>({
		mutationFn: ({ messageId, agentId }) =>
			api.conversations.retryMessage(id, workspaceId, messageId, agentId),
		onSuccess: () => {
			toast.success('Asked the agents to respond')
		},
		onError: () => {
			toast.error('Failed to retry')
		},
	})
}

// Rewinds the thread to a message: everything from it onward moves onto the
// parent branch, a copy is re-sent on a fresh branch, and the agents answer
// again with no memory of the discarded tail. Nothing is deleted — the old tail
// stays reachable through the branch switcher.
//
// No optimistic update: the server decides the new branch id and the new message
// id, and a wrong guess would render a thread that doesn't exist. Refetching is
// fast and the button shows a pending state meanwhile.
export function useRewindMessage(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<{ branch_id: string; message: MessageResponse }, Error, { messageId: number }>(
		{
			mutationFn: ({ messageId }) => api.conversations.rewindMessage(id, workspaceId, messageId),
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: queryKeys.conversations.messagesPrefix(id) })
				queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
			},
			onError: (err) => {
				// The server refuses a rewind that would remove someone else's message.
				// Say which it is — "Failed to rewind" leaves the user re-clicking.
				toast.error(
					err.message.includes('replied since')
						? 'Someone else has replied since — rewinding would remove their message.'
						: 'Failed to rewind',
				)
			},
		},
	)
}

// Switches which branch of a rewound conversation is being read. Server-side
// state, not a client-side view toggle: the agents answer on the active branch,
// so it has to be the same choice for the whole conversation.
export function useSwitchBranch(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<{ branch_id: string | null }, Error, { branchId: string | null }>({
		mutationFn: ({ branchId }) => api.conversations.switchBranch(id, workspaceId, branchId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.messagesPrefix(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
		},
		onError: () => {
			toast.error('Failed to switch branch')
		},
	})
}

export function useAddConversationParticipants(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (actorIds: string[]) =>
			api.conversations.addParticipants(id, workspaceId, actorIds),
		onError: () => {
			toast.error('Failed to add participants')
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
		},
	})
}

export function useRemoveConversationParticipant(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (actorId: string) => api.conversations.removeParticipant(id, actorId, workspaceId),
		onError: () => {
			toast.error('Failed to remove participant')
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
		},
	})
}
