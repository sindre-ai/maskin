import { type ForYouDismissBody, type ForYouItem, type UnreadItem, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Projects a curated item into the shape the feed's cards already render, so
 * the card, dismiss and decision machinery is shared with the unread stream.
 * `latest_event_id` is the source comment. Dismiss, a threaded reply to it or an
 * option tap retires the item server-side; reading its object does not.
 */
export function forYouItemToFeedItem(item: ForYouItem): UnreadItem | null {
	if (!item.entity_id || !item.entity_type) return null
	return {
		entity_type: item.entity_type,
		entity_id: item.entity_id,
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: item.latest_mention?.attention ?? null,
		latest_event_id: item.latest_mention?.event_id ?? item.latest_event_id,
		latest_activity_at: item.latest_mention?.created_at ?? item.created_at,
		object: item.object,
		latest_mention: item.latest_mention,
		curated: {
			headline: item.headline,
			rationale: item.rationale,
			notification_id: item.notification_id,
		},
	}
}

/** The Chief of Staff's ranked list, already in the order it should be shown. */
export function useForYou(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.forYou.list(workspaceId),
		queryFn: async () => {
			const { items } = await api.forYou.list(workspaceId)
			return {
				items: items.flatMap((item) => {
					const feedItem = forYouItemToFeedItem(item)
					return feedItem ? [feedItem] : []
				}),
			}
		},
		enabled: !!workspaceId,
	})
}

/** What Dismiss sends for a card: its notification when curated, else the comment that raised it. */
export function dismissBodyFor(item: UnreadItem): ForYouDismissBody | null {
	const notificationId = item.curated?.notification_id
	if (notificationId) return { notification_id: notificationId }
	const commentId = item.latest_mention?.event_id ?? item.latest_event_id
	return commentId && commentId > 0 ? { source_comment_id: commentId } : null
}

/** Dismiss a card, or bring it back (Undo). Both refresh the list so the server decides what shows. */
export function useDismissForYou(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ body, undo }: { body: ForYouDismissBody; undo?: boolean }) =>
			undo ? api.forYou.undismiss(workspaceId, body) : api.forYou.dismiss(workspaceId, body),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.forYou.list(workspaceId) })
		},
	})
}
