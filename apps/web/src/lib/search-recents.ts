// Per-workspace recently-searched queries and recently-opened objects for the
// /search empty state. localStorage keeps recents working across sessions with
// zero server round-trips; keys are scoped per workspace so switching workspaces
// never leaks another workspace's recents into the view.

const SEARCHES_MAX = 6
const OBJECTS_MAX = 4

function storageKey(workspaceId: string, kind: 'searches' | 'objects'): string {
	return `maskin-recent-${kind}-${workspaceId}`
}

function read<T>(key: string): T[] {
	try {
		const raw = localStorage.getItem(key)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as T[]) : []
	} catch {
		return []
	}
}

function write<T>(key: string, value: T[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(value))
	} catch {
		// Recents are best-effort; a full/privacy-mode storage must never throw.
	}
}

export function getRecentSearches(workspaceId: string): string[] {
	return read<string>(storageKey(workspaceId, 'searches')).filter((s) => typeof s === 'string')
}

export function pushRecentSearch(workspaceId: string, query: string): void {
	const q = query.trim()
	if (!q) return
	const key = storageKey(workspaceId, 'searches')
	write(key, [q, ...getRecentSearches(workspaceId).filter((s) => s !== q)].slice(0, SEARCHES_MAX))
}

export function getRecentObjectIds(workspaceId: string): string[] {
	return read<string>(storageKey(workspaceId, 'objects')).filter((s) => typeof s === 'string')
}

export function pushRecentObject(workspaceId: string, objectId: string): void {
	if (!objectId) return
	const key = storageKey(workspaceId, 'objects')
	write(
		key,
		[objectId, ...getRecentObjectIds(workspaceId).filter((id) => id !== objectId)].slice(
			0,
			OBJECTS_MAX,
		),
	)
}
