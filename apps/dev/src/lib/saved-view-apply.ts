import { normalizeTags } from '@maskin/shared'

/** One row of a list a view can be applied to, already in the order that list shows. */
export interface ViewRow {
	id: string
	tags: string[]
	driverId: string | null
}

export interface ViewRules {
	filter: { tags?: string[]; driverId?: string }
	groupBy: 'tag' | 'driver' | null
}

export interface ViewGroup {
	key: string | null
	ids: string[]
}

/**
 * Applies a saved view to rows. A row stays when it carries every tag in the filter (compared
 * without regard to capitalisation) and, for a flow view, has the filter's driver. Then the
 * kept rows are split into groups:
 * - no group-by: one group with a null key, in the order given;
 * - by tag: a row sits under each of its own tags, and rows with no tag sit under a null key;
 * - by driver: a row sits under its driver's id, or under a null key.
 * Groups are sorted by key, the null group last. Rows keep the order they came in inside a group.
 */
export function applySavedView(rows: ViewRow[], view: ViewRules): ViewGroup[] {
	const wanted = normalizeTags(view.filter.tags).map((t) => t.toLowerCase())
	const kept = rows.filter((row) => {
		if (view.filter.driverId !== undefined && row.driverId !== view.filter.driverId) return false
		if (wanted.length === 0) return true
		const have = new Set(row.tags.map((t) => t.toLowerCase()))
		return wanted.every((t) => have.has(t))
	})

	if (view.groupBy === null) return [{ key: null, ids: kept.map((r) => r.id) }]

	// Tags group without regard to capitalisation; the first spelling seen is the key.
	const groups = new Map<string, ViewGroup>()
	const add = (mapKey: string, key: string | null, id: string) => {
		const group = groups.get(mapKey)
		if (group) group.ids.push(id)
		else groups.set(mapKey, { key, ids: [id] })
	}
	for (const row of kept) {
		if (view.groupBy === 'driver') {
			add(row.driverId ?? '', row.driverId, row.id)
			continue
		}
		const tags = normalizeTags(row.tags)
		if (tags.length === 0) add('', null, row.id)
		for (const tag of tags) add(tag.toLowerCase(), tag, row.id)
	}

	return [...groups.values()].sort((a, b) => {
		if (a.key === null) return 1
		if (b.key === null) return -1
		return a.key.toLowerCase().localeCompare(b.key.toLowerCase())
	})
}
