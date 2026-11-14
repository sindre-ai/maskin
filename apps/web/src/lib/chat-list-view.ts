/** The Chats list's two views: one row per agent with its chats folded under it, or the flat
 *  newest-first list. */
export type ChatListView = 'agents' | 'recent'

export const DEFAULT_CHAT_LIST_VIEW: ChatListView = 'agents'

const KEY_PREFIX = 'maskin-chat-list-view:'

function key(actorId: string | undefined): string {
	return `${KEY_PREFIX}${actorId ?? 'anonymous'}`
}

/** The view this person last chose; Agents when they never did or storage is unavailable. */
export function getStoredChatListView(actorId: string | undefined): ChatListView {
	try {
		const stored = localStorage.getItem(key(actorId))
		return stored === 'recent' || stored === 'agents' ? stored : DEFAULT_CHAT_LIST_VIEW
	} catch {
		return DEFAULT_CHAT_LIST_VIEW
	}
}

export function persistChatListView(actorId: string | undefined, view: ChatListView): void {
	try {
		localStorage.setItem(key(actorId), view)
	} catch {
		// storage may be unavailable (private mode); the choice then lasts for the session only
	}
}
