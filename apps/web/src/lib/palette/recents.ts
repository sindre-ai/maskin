// What the launcher shows before anything is typed: the items the viewer opened
// last, then recent chats, then recent loops. Pure, so the redesigned launcher
// can build the same list.

export const RECENTS_MAX = 4

export interface RecentItem {
	kind: 'object' | 'chat' | 'loop'
	id: string
	title: string
	/** Object type for objects ("bet"), so the row can show its kind. */
	type?: string
}

interface RecentsInput {
	/** Object ids in the order they were opened, newest first. */
	objectIds: string[]
	objects: { id: string; title: string | null; type: string }[]
	chats: { id: string; title: string; lastMessageAt: string | null; archived?: boolean }[]
	loops: { id: string; name: string | null; updatedAt: string | null }[]
	limit?: number
}

function newestFirst<T>(items: T[], at: (item: T) => string | null): T[] {
	const time = (item: T) => {
		const value = at(item)
		return value ? new Date(value).getTime() : 0
	}
	return [...items].sort((a, b) => time(b) - time(a))
}

export function buildRecents({
	objectIds,
	objects,
	chats,
	loops,
	limit = RECENTS_MAX,
}: RecentsInput): RecentItem[] {
	const byId = new Map(objects.map((object) => [object.id, object]))
	const items: RecentItem[] = []

	for (const id of objectIds) {
		const object = byId.get(id)
		if (object) {
			items.push({ kind: 'object', id, title: object.title ?? 'Untitled', type: object.type })
		}
	}
	for (const chat of newestFirst(
		chats.filter((c) => !c.archived),
		(c) => c.lastMessageAt,
	)) {
		items.push({ kind: 'chat', id: chat.id, title: chat.title || 'Untitled chat' })
	}
	for (const loop of newestFirst(loops, (l) => l.updatedAt)) {
		items.push({ kind: 'loop', id: loop.id, title: loop.name ?? 'Untitled loop' })
	}

	return items.slice(0, limit)
}
