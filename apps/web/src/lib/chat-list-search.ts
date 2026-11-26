import type { ChatsFilter } from '@/components/chat/chats-filter-menu'
import type { ChatPill } from '@/lib/chat-list-v2'

/**
 * Search for a link from a chat row to its thread. The router drops the parent route's search on a
 * navigation that names none, so without this the Unread pill (or a legacy filter) fell back to
 * All the moment a chat opened. Only the list's own state carries over; thread and msg belong to
 * the chat being left.
 */
export function keepListFilter(prev: { filter?: ChatsFilter; pill?: ChatPill }) {
	return { filter: prev.filter, pill: prev.pill }
}
