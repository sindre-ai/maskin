import {
	type InfiniteData,
	type QueryClient,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { useCallback } from 'react'
import { toast } from 'sonner'
import type { MessagesListResponse } from '../lib/api'
import { api } from '../lib/api'
import { getStoredActor } from '../lib/auth'
import { hasReacted, setReacted } from '../lib/message-reactions'
import { queryKeys } from '../lib/query-keys'
import { isViewerRefusal } from '../lib/workspace-role'

type Me = { id: string; name: string }

function storedMe(): Me | null {
	const actor = getStoredActor()
	return actor?.id ? { id: actor.id, name: actor.name ?? 'You' } : null
}

/** Whether the caller has reacted with `emoji`, as the cache says right now (optimistic changes included). */
function reactedNow(
	queryClient: QueryClient,
	conversationId: string,
	messageId: number,
	emoji: string,
): boolean {
	const caches = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
		queryKey: queryKeys.conversations.messagesPrefix(conversationId),
	})
	for (const [, cache] of caches) {
		for (const page of cache?.pages ?? []) {
			const found = page.messages.find((m) => m.id === messageId)
			if (found) return hasReacted(found.reactions, emoji)
		}
	}
	return false
}

/** Puts the caller's reaction in the wanted state on one message, in every cached page (main timeline and threads). */
function applyReacted(
	queryClient: QueryClient,
	conversationId: string,
	messageId: number,
	emoji: string,
	me: Me,
	reacted: boolean,
) {
	const caches = queryClient.getQueriesData<InfiniteData<MessagesListResponse>>({
		queryKey: queryKeys.conversations.messagesPrefix(conversationId),
	})
	for (const [key, cache] of caches) {
		if (!cache) continue
		queryClient.setQueryData<InfiniteData<MessagesListResponse>>(key, {
			...cache,
			pages: cache.pages.map((page) => ({
				...page,
				messages: page.messages.map((m) =>
					m.id === messageId ? { ...m, reactions: setReacted(m.reactions, emoji, me, reacted) } : m,
				),
			})),
		})
	}
}

/**
 * Adds or takes back the caller's emoji on a message.
 *
 * `toggle` decides the direction from the cache at that moment and changes the chip in the same
 * step, so two quick taps always mean add then remove, never the same direction twice. The calls
 * to the server run one after another per conversation (a mutation scope), so they reach it in
 * the order they were tapped and the final state is the last choice. If a call is refused, only
 * its own change is undone: the undo sets the state it had flipped, so it leaves later taps and
 * other messages alone. Nothing refetches here: the server records a `message_updated` event for
 * every real add or remove, and the live message refresh already re-reads the page for it.
 */
export function useToggleReaction(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	const mutation = useMutation<void, Error, { messageId: number; emoji: string; adding: boolean }>({
		scope: { id: `message-reactions:${id}` },
		mutationFn: ({ messageId, emoji, adding }) =>
			adding
				? api.conversations.reactToMessage(id, workspaceId, messageId, emoji)
				: api.conversations.unreactToMessage(id, workspaceId, messageId, emoji),
		onError: (error, { messageId, emoji, adding }) => {
			const me = storedMe()
			if (me) applyReacted(queryClient, id, messageId, emoji, me, !adding)
			// A viewer's refused write already got the shared message.
			if (!isViewerRefusal(error)) toast.error('Failed to react')
		},
	})
	const { mutate } = mutation
	const toggle = useCallback(
		(messageId: number, emoji: string) => {
			const adding = !reactedNow(queryClient, id, messageId, emoji)
			// Without a stored person there is nobody to show in the chip, so the change waits for the server.
			const me = storedMe()
			if (me) applyReacted(queryClient, id, messageId, emoji, me, adding)
			// A refetch already in flight would land older data over the chip. Keep what the chip says.
			void queryClient.cancelQueries(
				{ queryKey: queryKeys.conversations.messagesPrefix(id) },
				{ revert: false },
			)
			mutate({ messageId, emoji, adding })
		},
		[queryClient, id, mutate],
	)
	return { toggle }
}
