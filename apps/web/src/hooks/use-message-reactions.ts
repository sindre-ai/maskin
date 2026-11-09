import { type InfiniteData, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { MessagesListResponse } from '../lib/api'
import { api } from '../lib/api'
import { getStoredActor } from '../lib/auth'
import { toggleReaction } from '../lib/message-reactions'
import { queryKeys } from '../lib/query-keys'
import { isViewerRefusal } from '../lib/workspace-role'

type Snapshots = [readonly unknown[], InfiniteData<MessagesListResponse> | undefined][]

// Adds or takes back the caller's emoji on a message. The chip changes at once in every cached
// page (the main timeline and any thread), is rolled back if the server refuses, and is
// reconciled with the server's list when the conversation refetches.
export function useToggleReaction(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<
		void,
		Error,
		{ messageId: number; emoji: string; adding: boolean },
		{ snapshots: Snapshots }
	>({
		mutationFn: ({ messageId, emoji, adding }) =>
			adding
				? api.conversations.reactToMessage(id, workspaceId, messageId, emoji)
				: api.conversations.unreactToMessage(id, workspaceId, messageId, emoji),
		onMutate: async ({ messageId, emoji }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.conversations.messagesPrefix(id) })
			const snapshots = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
			const actor = getStoredActor()
			const me = { id: actor?.id ?? '', name: actor?.name ?? 'You' }
			for (const [key, cache] of snapshots) {
				if (!cache) continue
				queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
					...cache,
					pages: cache.pages.map((page) => ({
						...page,
						messages: page.messages.map((m) =>
							m.id === messageId ? { ...m, reactions: toggleReaction(m.reactions, emoji, me) } : m,
						),
					})),
				})
			}
			return { snapshots }
		},
		onError: (error, _vars, ctx) => {
			if (ctx) for (const [key, cache] of ctx.snapshots) queryClient.setQueryData(key, cache)
			// A viewer's refused write already got the shared message.
			if (!isViewerRefusal(error)) toast.error('Failed to react')
		},
		onSettled: () => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.conversations.messagesPrefix(id),
			})
		},
	})
}
