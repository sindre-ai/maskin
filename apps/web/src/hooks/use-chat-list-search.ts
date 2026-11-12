// The chat list's search box: one call to GET /api/search for chats only, so a chat is found by
// its title, a person in it or a word in its messages, whether or not the list has loaded it.

import {
	SEARCH_QUERY_DEBOUNCE_MS,
	useDebouncedValue,
	useSearchQuery,
} from '@/hooks/use-search-query'

const CHAT_TYPES = ['chat']
const NO_FILTERS: string[] = []

export function useChatListSearch(workspaceId: string, text: string) {
	const typed = text.trim()
	const debounced = useDebouncedValue(typed, SEARCH_QUERY_DEBOUNCE_MS)
	const query = useSearchQuery(
		workspaceId,
		{ text: debounced, types: CHAT_TYPES, statuses: NO_FILTERS, updated: '', sort: 'rel' },
		typed !== '',
	)
	// Words typed but not yet sent: the previous answer is on screen, so show it as pending.
	return { ...query, pending: typed !== debounced }
}
