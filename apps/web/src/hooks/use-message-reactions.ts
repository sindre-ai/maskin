import {
	type InfiniteData,
	type QueryClient,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type { MessagesListResponse } from '../lib/api'
import { api } from '../lib/api'
import { getStoredActor } from '../lib/auth'
import { hasReacted, setReacted } from '../lib/message-reactions'
import { queryKeys } from '../lib/query-keys'
import { VIEWER_READ_ONLY_MESSAGE, isViewerRefusal } from '../lib/workspace-role'

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
 * its own change is undone: when a later tap on the same emoji is still waiting, the chip takes
 * that tap's choice (the server will end up holding it), otherwise it goes back to the state the
 * refused call had flipped. Other messages are left alone. Nothing refetches here: the server
 * records a `message_updated` event for every real add or remove, and the live message refresh
 * already re-reads the page for it.
 */
export function useToggleReaction(id: string, workspaceId: string) {
	const queryClient = useQueryClient()
	// The choices still waiting for the server, oldest first, per message and emoji. The calls
	// run in tap order, so a call that finishes is always the oldest one in its list.
	const waiting = useRef(new Map<string, boolean[]>())
	const finish = (messageId: number, emoji: string) => {
		const key = `${messageId}:${emoji}`
		const list = waiting.current.get(key) ?? []
		list.shift()
		if (list.length === 0) waiting.current.delete(key)
		return list
	}
	const mutation = useMutation<void, Error, { messageId: number; emoji: string; adding: boolean }>({
		scope: { id: `message-reactions:${id}` },
		// The hook toasts its own failure; the global handler would stack a second one.
		meta: { handlesOwnErrors: true },
		mutationFn: ({ messageId, emoji, adding }) =>
			adding
				? api.conversations.reactToMessage(id, workspaceId, messageId, emoji)
				: api.conversations.unreactToMessage(id, workspaceId, messageId, emoji),
		onSuccess: (_data, { messageId, emoji }) => {
			finish(messageId, emoji)
		},
		onError: (error, { messageId, emoji, adding }) => {
			const later = finish(messageId, emoji)
			const me = storedMe()
			// A later tap still runs after this one and decides what the server ends up holding.
			if (me)
				applyReacted(queryClient, id, messageId, emoji, me, later[later.length - 1] ?? !adding)
			// The global handler is opted out above, so a viewer's refused write gets its shared
			// message here, once, with the same id the global handler uses.
			if (isViewerRefusal(error)) toast.error(VIEWER_READ_ONLY_MESSAGE, { id: 'viewer-read-only' })
			else toast.error('Failed to react')
		},
	})
	const { mutate } = mutation
	const toggle = useCallback(
		(messageId: number, emoji: string) => {
			const adding = !reactedNow(queryClient, id, messageId, emoji)
			// Without a stored person there is nobody to show in the chip, so the change waits for the server.
			const me = storedMe()
			if (me) applyReacted(queryClient, id, messageId, emoji, me, adding)
			const key = `${messageId}:${emoji}`
			waiting.current.set(key, [...(waiting.current.get(key) ?? []), adding])
			// A refetch already in flight would land older data over the chip. Cancel it. The default
			// (revert) puts each query back to its state before the fetch, which is the optimistic data
			// set just above, and does not turn the query into an error.
			void queryClient.cancelQueries({ queryKey: queryKeys.conversations.messagesPrefix(id) })
			mutate({ messageId, emoji, adding })
		},
		[queryClient, id, mutate],
	)
	return { toggle }
}
