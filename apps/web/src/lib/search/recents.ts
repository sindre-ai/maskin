// Reads recent searches from localStorage. The key is the one the old search page
// already writes (strings only), so both shapes are accepted: a plain string is a
// text-only search, an object carries filters too. Entries that are neither are dropped.

export interface RecentSearch {
	q: string
	types: string[]
	statuses: string[]
}

export const RECENT_SEARCHES_MAX = 5

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : []

export function normalizeRecentSearch(entry: unknown): RecentSearch | null {
	if (typeof entry === 'string') {
		const q = entry.trim()
		return q ? { q, types: [], statuses: [] } : null
	}
	if (!entry || typeof entry !== 'object') return null
	const e = entry as Record<string, unknown>
	const q = typeof e.q === 'string' ? e.q.trim() : ''
	const types = strings(e.types)
	const statuses = strings(e.statuses)
	// An entry with neither words nor filters would be an empty row.
	return q || types.length || statuses.length ? { q, types, statuses } : null
}

export function getRecentSearchEntries(workspaceId: string): RecentSearch[] {
	try {
		const raw = localStorage.getItem(`maskin-recent-searches-${workspaceId}`)
		const parsed: unknown = raw ? JSON.parse(raw) : []
		if (!Array.isArray(parsed)) return []
		return parsed
			.map(normalizeRecentSearch)
			.filter((r): r is RecentSearch => r !== null)
			.slice(0, RECENT_SEARCHES_MAX)
	} catch {
		return []
	}
}

const sameEntry = (a: RecentSearch, b: RecentSearch) =>
	a.q === b.q &&
	a.types.join(',') === b.types.join(',') &&
	a.statuses.join(',') === b.statuses.join(',')

/**
 * Remembers a search that ended in an opened result: words and pills. The same
 * search moves to the front instead of repeating. The old page reads this key as
 * strings only and skips objects, so switching the flag off again is safe.
 */
export function pushRecentSearchEntry(workspaceId: string, entry: RecentSearch): void {
	const next = normalizeRecentSearch(entry)
	if (!next) return
	try {
		const rest = getRecentSearchEntries(workspaceId).filter((r) => !sameEntry(r, next))
		localStorage.setItem(
			`maskin-recent-searches-${workspaceId}`,
			JSON.stringify([next, ...rest].slice(0, RECENT_SEARCHES_MAX)),
		)
	} catch {
		// Recents are best-effort; full or private storage must never throw.
	}
}
