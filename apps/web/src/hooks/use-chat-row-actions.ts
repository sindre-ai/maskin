// The new chat list's row actions: Done, Later, Undo and Retry. One list of actions serves the hover
// cluster, the ··· menu and the touch button, so every way in does the same thing and reports the
// same event. Done is the existing archive; Later is the caller's own flag.

import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { type ChatRowActionVia, trackChatRowAction } from '@/lib/analytics'
import { type ConversationListItemResponse, type ConversationListResponse, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { type InfiniteData, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

/** How long a toast keeps its Undo. */
export const UNDO_MS = 6000

export const DONE_TOAST = 'Marked done'
export const LATER_TOAST = 'Moved to Later. A new message brings it back.'
export const RETRY_TOAST = 'Retrying'

export function useChatRowActions(workspaceId: string) {
	const updateMe = useUpdateConversationMe(workspaceId)
	const queryClient = useQueryClient()

	const done = (c: ConversationListItemResponse, via: ChatRowActionVia) => {
		trackChatRowAction({ action: 'done', via })
		updateMe.mutate({ id: c.id, data: { archived: true } })
		toast(DONE_TOAST, {
			duration: UNDO_MS,
			action: {
				label: 'Undo',
				onClick: () => {
					trackChatRowAction({ action: 'undo', via })
					updateMe.mutate({ id: c.id, data: { archived: false } })
				},
			},
		})
	}

	const later = (c: ConversationListItemResponse, via: ChatRowActionVia) => {
		trackChatRowAction({ action: 'later', via })
		updateMe.mutate({ id: c.id, data: { later: true } })
		toast(LATER_TOAST, {
			duration: UNDO_MS,
			action: {
				label: 'Undo',
				onClick: () => {
					trackChatRowAction({ action: 'undo', via })
					updateMe.mutate({ id: c.id, data: { later: false } })
				},
			},
		})
	}

	// The same call the Retry button in the thread makes, for the last person message. The marker
	// clears at once; if the turn fails again the list's live updates bring it back with its new reason.
	const retry = async (c: ConversationListItemResponse, via: ChatRowActionVia) => {
		if (!c.error) return
		trackChatRowAction({ action: 'retry', via })
		const key = queryKeys.conversations.listInfinitePrefix(workspaceId)
		const snapshots = queryClient.getQueriesData<InfiniteData<ConversationListResponse>>({
			queryKey: key,
		})
		for (const [k, cache] of snapshots) {
			if (!cache) continue
			queryClient.setQueryData<InfiniteData<ConversationListResponse>>(k, {
				...cache,
				pages: cache.pages.map((page) => ({
					...page,
					conversations: page.conversations.map((x) => (x.id === c.id ? { ...x, error: null } : x)),
				})),
			})
		}
		toast(RETRY_TOAST)
		try {
			await api.conversations.retryMessage(c.id, workspaceId, c.error.message_id)
		} catch {
			for (const [k, cache] of snapshots) queryClient.setQueryData(k, cache)
			toast.error('Failed to retry')
		}
	}

	// The list carries no newest-message id, so read the chat's newest one (as Mark all read does).
	const markRead = async (c: ConversationListItemResponse) => {
		try {
			const res = await api.conversations.messages(c.id, workspaceId)
			const newest = Math.max(0, ...res.messages.map((m) => m.id))
			if (newest > 0)
				await updateMe.mutateAsync({ id: c.id, data: { last_read_message_id: newest } })
		} catch {
			toast.error("Couldn't mark this chat as read")
		}
	}

	const markUnread = (c: ConversationListItemResponse) =>
		updateMe.mutate({ id: c.id, data: { mark_unread: true } })

	const togglePinned = (c: ConversationListItemResponse) =>
		updateMe.mutate({ id: c.id, data: { pinned: !c.pinned } })

	return { done, later, retry, markRead, markUnread, togglePinned }
}
