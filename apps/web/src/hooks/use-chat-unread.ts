import { useConversationsInfinite } from '@/hooks/use-conversations'

/**
 * Unread-chat count for the sidebar's Chats nav entry. Reuses the
 * conversations list hook filtered to `unread_only`, so it always agrees with
 * the Chats list's own unread state instead of a second server round-trip.
 * `hasMore` signals the count is a floor (there are more unread conversations
 * than the first page holds) so the caller can render "9+" instead of a
 * precise number that would understate the truth.
 */
export function useChatUnreadCount(workspaceId: string): { count: number; hasMore: boolean } {
	const { data } = useConversationsInfinite(workspaceId, { unread_only: true })
	const firstPage = data?.pages?.[0]
	return {
		count: firstPage?.conversations.length ?? 0,
		hasMore: firstPage?.has_more ?? false,
	}
}
