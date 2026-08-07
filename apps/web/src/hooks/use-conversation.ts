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
