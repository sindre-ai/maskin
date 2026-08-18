import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

// The sidebar's Chats badge counts conversations with unread messages, not
// unread messages themselves — one badge unit per chat that wants attention.
// The list endpoint has no total, so the count is capped at one page and the
// caller renders `${CHAT_UNREAD_CAP}+` when the page reports more.
export const CHAT_UNREAD_CAP = 50

export function useChatUnreadCount(workspaceId: string) {
	const query = useQuery({
		queryKey: queryKeys.conversations.unreadCount(workspaceId),
		queryFn: () =>
			api.conversations.list(workspaceId, {
				unread_only: 'true',
				limit: String(CHAT_UNREAD_CAP),
			}),
		enabled: !!workspaceId,
	})

	return {
		count: query.data?.conversations.length ?? 0,
		hasMore: query.data?.has_more ?? false,
	}
}
