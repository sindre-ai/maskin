// Helpers for the chat list's search: which hits the default list leaves out, and where the
// matching line of a hit comes from. The list search asks the server's unified search for chats
// only, so a hit can be any chat the person is in, loaded or not.

import type { ConversationListItemResponse } from '@/lib/api'
import type { SearchResultRow } from '@maskin/shared'

/** What the default list has loaded, as far as it tells us which chats it leaves out. */
export interface LoadedList {
	/** Every chat the default list holds right now. */
	ids: ReadonlySet<string>
	/** True when the list still has pages to load (its tail is not known yet). */
	hasMore: boolean
	/** Activity time of the oldest chat in the paged part of the list, null when it is empty. */
	oldestActivityAt: number | null
}

export function activityTime(c: Pick<ConversationListItemResponse, 'lastMessageAt' | 'createdAt'>) {
	const at = c.lastMessageAt ?? c.createdAt
	return at ? new Date(at).getTime() : 0
}

/**
 * A hit is "archived" in the list when the person archived it, or when the default list leaves
 * it out (the quiet-chat rule). The list is newest-activity first, so once everything is loaded
 * a missing chat is left out; while pages remain, a missing chat is left out only if it is newer
 * than the oldest loaded row, because everything newer than that row has already come in.
 * With no list to compare to (a filtered list), only the person's own archive counts.
 */
export function isArchivedHit(row: SearchResultRow, loaded: LoadedList | null): boolean {
	if (row.status === 'archived') return true
	if (!loaded || loaded.ids.has(row.id)) return false
	if (!loaded.hasMore) return true
	if (loaded.oldestActivityAt === null || !row.updatedAt) return false
	return new Date(row.updatedAt).getTime() >= loaded.oldestActivityAt
}

/**
 * The muted line under a hit's title. The server sends the newest message holding the typed
 * words as the snippet; a hit found by a person's name has no matching message, so the people
 * line carries the match instead.
 */
export function hitLine(row: SearchResultRow, query: string): string | null {
	const q = query.trim().toLowerCase()
	const snippet = row.snippet?.trim() ? row.snippet : null
	const sub = row.sub?.trim() ? row.sub : null
	if (q && sub && sub.toLowerCase().includes(q) && !snippet?.toLowerCase().includes(q)) return sub
	return snippet ?? sub
}
