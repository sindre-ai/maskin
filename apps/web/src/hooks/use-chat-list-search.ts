// The chat list's search box: one call to GET /api/search for chats only, so a chat is found by
// its title, a person in it or a word in its messages, whether or not the list has loaded it.

import {
	SEARCH_QUERY_DEBOUNCE_MS,
	useDebouncedValue,
	useSearchQuery,
} from '@/hooks/use-search-query'
import { STATUS_GROUP_KEYS } from '@maskin/shared'

const CHAT_TYPES = ['chat']
// The server leaves archived chats out unless Archived is among the statuses asked for. Asking for
// all five groups is "every chat", archived ones included.
const EVERY_STATUS: string[] = [...STATUS_GROUP_KEYS]

export function useChatListSearch(workspaceId: string, text: string) {
	const typed = text.trim()
	const debounced = useDebouncedValue(typed, SEARCH_QUERY_DEBOUNCE_MS)
	const query = useSearchQuery(
		workspaceId,
		{ text: debounced, types: CHAT_TYPES, statuses: EVERY_STATUS, updated: '', sort: 'rel' },
		typed !== '',
	)
	// Words typed but not yet sent: the previous answer is on screen, so show it as pending.
	return { ...query, pending: typed !== debounced }
}
