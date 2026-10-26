import { type ForYouItem, type UnreadItem, api } from '@/lib/api'
import { NOTIFICATION_ENTITY } from '@/lib/foryou-feed'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

/**
 * Projects a curated item into the shape the feed's cards already render, so
 * the card, dismiss and decision machinery is shared with the unread stream.
 * `latest_event_id` is the source comment: marking it read is what retires the
 * item server-side.
 */
export function forYouItemToFeedItem(item: ForYouItem): UnreadItem | null {
	// A card with no object (the morning budget card) is keyed by its notification, which is
	// what dismissing it resolves. Without either there is nothing to open or to dismiss.
	const objectless = !item.entity_id || !item.entity_type
	if (objectless && !item.notification_id) return null
	return {
		entity_type: objectless ? NOTIFICATION_ENTITY : (item.entity_type as string),
		entity_id: objectless ? (item.notification_id as string) : (item.entity_id as string),
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: item.latest_mention?.attention ?? null,
		latest_event_id: item.latest_mention?.event_id ?? item.latest_event_id,
		latest_activity_at: item.latest_mention?.created_at ?? item.created_at,
		object: item.object,
		latest_mention: item.latest_mention,
		curated: { headline: item.headline, rationale: item.rationale },
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
