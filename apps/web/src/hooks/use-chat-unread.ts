import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

/**
 * Unread-chat count for the sidebar's Chats nav entry. One count query
 * (`GET /conversations/unread-count`) with the same visibility rules as the
 * list's `unread_only` filter, instead of hydrating a page of conversations
 * just to count them. The count is exact, so `hasMore` is always false.
 * Marking a chat read or a new message invalidates `conversations.all`,
 * which prefixes this key.
 */
export function useChatUnreadCount(workspaceId: string): { count: number; hasMore: boolean } {
	const { data } = useQuery({
		queryKey: queryKeys.conversations.unreadCount(workspaceId),
		queryFn: () => api.conversations.unreadCount(workspaceId),
		enabled: !!workspaceId,
	})
	return { count: data?.count ?? 0, hasMore: false }
}
