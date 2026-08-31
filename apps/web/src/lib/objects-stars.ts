// Per-workspace "starred objects" set, persisted in localStorage.
//
// Starring is a personal bookmark, not workspace state: two members of the same
// workspace star different things, and a star carries no meaning to an agent.
// The mockup models it the same way (script 6159's `stars[o.id]` lives in view
// state, never on the object), so there is no API field to write to and adding
// one would publish a private signal into the shared audit log.
//
// localStorage rather than the in-memory store used by `objects-view-state.ts`:
// a star is meant to outlive the tab that set it. It is deliberately *not*
// synced across devices — that is the trade for not modelling it server-side.

const KEY_PREFIX = 'maskin-object-stars:'

function storageKey(workspaceId: string): string {
	return `${KEY_PREFIX}${workspaceId}`
}

// Session fallback for workspaces whose last write to `localStorage` threw
// (Safari private mode, quota, storage disabled by policy). Holding the set
// here keeps starring working for the rest of the session — the part the user
// can see — instead of silently reverting on the next read. A successful write
// clears the entry, so storage stays authoritative whenever it is usable.
const memoryFallback = new Map<string, Set<string>>()

/** Reads the starred-id set. Returns empty on any storage failure — a private
 *  bookmark is never worth breaking a list render over (Safari private mode
 *  throws on `localStorage` access, and a hand-edited value can be non-JSON). */
export function readStars(workspaceId: string): Set<string> {
	const fallback = memoryFallback.get(workspaceId)
	if (fallback) return new Set(fallback)
	try {
		const raw = localStorage.getItem(storageKey(workspaceId))
		if (!raw) return new Set()
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return new Set()
		return new Set(parsed.filter((id): id is string => typeof id === 'string'))
	} catch {
		return new Set()
	}
}

export function writeStars(workspaceId: string, ids: Set<string>): void {
	try {
		localStorage.setItem(storageKey(workspaceId), JSON.stringify([...ids]))
		memoryFallback.delete(workspaceId)
	} catch {
		// Quota or private-mode failure — hold the set in memory so it stays
		// correct for this session, which is the part the user can see. It is
		// lost on reload; a private bookmark is not worth surfacing an error for.
		memoryFallback.set(workspaceId, new Set(ids))
	}
	// The `storage` event fires only in the *other* tabs, so a write here is
	// invisible to every other `useObjectStars` in this one — and there is more
	// than one (the list row's and the route's, which drives the Starred filter
	// and its count). Notify them directly; cross-tab sync stays on `storage`.
	notify(workspaceId)
}

type StarsListener = (workspaceId: string) => void

const listeners = new Set<StarsListener>()

function notify(workspaceId: string): void {
	for (const listener of listeners) listener(workspaceId)
}

/** Subscribes to same-tab star writes. Returns an unsubscribe function. */
export function subscribeToStars(listener: StarsListener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
