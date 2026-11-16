import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
	ConversationListResponse,
	CreateConversationInput,
	UpdateConversationInput,
	UpdateConversationParticipantStateInput,
} from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

const CONVERSATIONS_PAGE_SIZE = 30
// The chat rail's "Earlier" section opens with this many chats, newest message first.
const RECENT_PAGE_SIZE = 20
// Direct messages, pinned and unread chats are all loaded; this is the page size they stream in at
// (the API's maximum), not a cap.
const PRIORITY_PAGE_SIZE = 100

export interface ConversationListFilters {
	pinned?: boolean
	archived?: boolean
	unread_only?: boolean
	/** `priority`: direct messages, pinned and unread chats. `recent`: all other chats. */
	scope?: 'priority' | 'recent'
	/** The default list's listing rules: no empty agent DMs, retired agents or quiet topic chats. */
	hide_quiet?: boolean
}

export function useConversationsInfinite(
	workspaceId: string,
	filters?: ConversationListFilters,
	options?: { enabled?: boolean },
) {
	const pageSize =
		filters?.scope === 'priority'
			? PRIORITY_PAGE_SIZE
			: filters?.scope === 'recent'
				? RECENT_PAGE_SIZE
				: CONVERSATIONS_PAGE_SIZE
	return useInfiniteQuery({
		queryKey: queryKeys.conversations.listInfinite(workspaceId, filters as Record<string, unknown>),
		queryFn: ({ pageParam }) => {
			const params: Record<string, string> = {
				limit: String(pageSize),
				offset: String(pageParam),
			}
			if (filters?.scope) {
				params.scope = filters.scope
				params.sort = 'activity'
			}
			// zod's `z.coerce.boolean()` on the backend runs `Boolean(str)`, so any
			// non-empty string — including the literal "false" — coerces to
			// `true`. Only ever send these params when `true`; omit them
			// otherwise and rely on the backend's own default (archived
			// defaults to `false` server-side).
			if (filters?.pinned) params.pinned = 'true'
			if (filters?.archived) params.archived = 'true'
			if (filters?.unread_only) params.unread_only = 'true'
			if (filters?.hide_quiet) params.hide_quiet = 'true'
			return api.conversations.list(workspaceId, params)
		},
		initialPageParam: 0,
		getNextPageParam: (lastPage, allPages) =>
			lastPage.has_more ? allPages.length * pageSize : undefined,
		enabled: !!workspaceId && (options?.enabled ?? true),
	})
}

export function useCreateConversation(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateConversationInput) => api.conversations.create(workspaceId, data),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.conversations.detail(data.id), data)
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(workspaceId) })
		},
	})
}

export function useUpdateConversation(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateConversationInput }) =>
			api.conversations.update(id, workspaceId, data),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.conversations.detail(data.id), data)
		},
		onError: () => {
			toast.error('Failed to rename conversation')
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
		},
	})
}

interface ConversationMeContext {
	snapshots: Array<[readonly unknown[], InfiniteData<ConversationListResponse> | undefined]>
}

// Optimistic pin/archive/mark-read against the caller's own participant row.
// Patches every cached list page so the sidebar reflects the change instantly;
// onSettled reconciles with the server (unread_count in particular is
// server-computed and may differ from the optimistic zero we apply here).
export function useUpdateConversationMe(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<
		unknown,
		Error,
		{ id: string; data: UpdateConversationParticipantStateInput },
		ConversationMeContext
	>({
		mutationFn: ({ id, data }) => api.conversations.updateMe(id, workspaceId, data),
		onMutate: async ({ id, data }) => {
			await queryClient.cancelQueries({
				queryKey: queryKeys.conversations.listInfinitePrefix(workspaceId),
			})
			const snapshots = queryClient.getQueriesData<InfiniteData<ConversationListResponse>>({
				queryKey: queryKeys.conversations.listInfinitePrefix(workspaceId),
			})
			// A `mark_unread` reset deliberately leaves the row's unread state
			// alone — the count is server-computed, and forcing it to a guess would
			// be wrong until the server re-reads it. Only a genuine read-marker
			// advance (`last_read_message_id`) gets the optimistic `unread_count: 0`.
			// `onSettled` reconciles the true count via invalidation either way.
			for (const [key, cache] of snapshots) {
				if (!cache) continue
				queryClient.setQueryData<InfiniteData<ConversationListResponse>>(key, {
					...cache,
					pages: cache.pages.map((page) => ({
						...page,
						conversations: page.conversations.map((c) =>
							c.id === id
								? {
										...c,
										...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
										...(data.archived !== undefined ? { archived: data.archived } : {}),
										...(data.last_read_message_id !== undefined ? { unread_count: 0 } : {}),
									}
								: c,
						),
					})),
				})
			}
			return { snapshots }
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return
			for (const [key, cache] of ctx.snapshots) queryClient.setQueryData(key, cache)
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
		},
	})
}
