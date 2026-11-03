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
import { threadRootOfQueryKey } from '../lib/message-threads'
import { queryKeys } from '../lib/query-keys'
import { isViewerRefusal } from '../lib/workspace-role'

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
function fetchMessagesPage(
	id: string,
	workspaceId: string,
	pageParam: number | undefined,
	extra?: Record<string, string>,
) {
	const params: Record<string, string> = { limit: String(MESSAGES_PAGE_SIZE), ...extra }
	if (pageParam) params.before_id = String(pageParam)
	return api.conversations.messages(id, workspaceId, params)
}

function nextMessagesPageParam(lastPage: MessagesListResponse) {
	if (!lastPage.has_more || lastPage.messages.length === 0) return undefined
	return lastPage.messages[lastPage.messages.length - 1]?.id
}

export function useConversationMessages(
	id: string,
	workspaceId: string,
	options?: { enabled?: boolean },
) {
	return useInfiniteQuery({
		queryKey: queryKeys.conversations.messages(id, { limit: MESSAGES_PAGE_SIZE }),
		queryFn: ({ pageParam }) => fetchMessagesPage(id, workspaceId, pageParam),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: nextMessagesPageParam,
		enabled: !!id && !!workspaceId && (options?.enabled ?? true),
	})
}

/** The replies under one top-level message, paged newest-first like the main list. */
export function useThreadReplies(
	id: string,
	workspaceId: string,
	rootId: number,
	options?: { enabled?: boolean },
) {
	return useInfiniteQuery({
		queryKey: queryKeys.conversations.threadMessages(id, rootId),
		queryFn: ({ pageParam }) =>
			fetchMessagesPage(id, workspaceId, pageParam, { thread_root_id: String(rootId) }),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: nextMessagesPageParam,
		enabled: !!id && !!workspaceId && rootId > 0 && (options?.enabled ?? true),
	})
}

/** Threads the caller is in, across conversations. Used to resolve a deep-linked root. */
export function useReplyThreads(workspaceId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.conversations.replyThreads(workspaceId),
		queryFn: () => api.conversations.replyThreads(workspaceId, { limit: 100 }),
		enabled: !!workspaceId && (options?.enabled ?? true),
	})
}

/**
 * Advances the caller's read cursor for one thread. The pill's unread count is
 * zeroed on the root in every main-list cache straight away (advance-only, so
 * there is nothing to roll back). On settle only the reply-thread list and the
 * main-list message caches refetch, never the open thread query: a main-page
 * refetch that was issued before the PUT committed could otherwise land after
 * the zeroing and bring a stale unread pill back.
 */
export function useMarkThreadRead(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<
		{ last_read_message_id: number },
		Error,
		{ rootId: number; lastReadMessageId: number }
	>({
		mutationFn: ({ rootId, lastReadMessageId }) =>
			api.conversations.markThreadRead(id, workspaceId, rootId, lastReadMessageId),
		onMutate: ({ rootId }) => {
			const caches = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			for (const [key, cache] of caches) {
				if (!cache || threadRootOfQueryKey(key) !== null) continue
				queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
					...cache,
					pages: cache.pages.map((page) => ({
						...page,
						messages: page.messages.map((m) =>
							m.id === rootId && m.thread ? { ...m, thread: { ...m.thread, unreadCount: 0 } } : m,
						),
					})),
				})
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.replyThreads(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.conversations.messagesPrefix(id),
				predicate: (query) => threadRootOfQueryKey(query.queryKey) === null,
			})
		},
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
			const sendRoot = data.thread_root_id ?? null
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
				threadRootId: sendRoot,
				threadAlsoInChannel: sendRoot !== null && data.also_in_channel === true,
			}
			const snapshots = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			for (const [key, cache] of snapshots) {
				if (!cache || cache.pages.length === 0) continue
				// A top-level send belongs only in main-list caches; a reply goes to those and to
				// its own thread's cache, never to another root's.
				const cacheRoot = threadRootOfQueryKey(key)
				if (cacheRoot !== null && cacheRoot !== sendRoot) continue
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
		onError: (error) => {
			// A viewer's refused retry already got the shared message.
			if (!isViewerRefusal(error)) toast.error('Failed to retry')
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

/**
 * How the person answered the card in message `messageId`, read from the chat itself so
 * it holds after a reload. Null while it is unanswered (or the messages are not loaded).
 */
export function useCardAnswer(
	conversationId: string,
	workspaceId: string,
	messageId: number,
): 'declined' | 'done' | null {
	const { data } = useConversationMessages(conversationId, workspaceId)
	for (const m of flattenMessagesOldestFirst(data)) {
		if (m.metadata?.card_answer?.message_id === messageId) return m.metadata.card_answer.outcome
	}
	return null
}
