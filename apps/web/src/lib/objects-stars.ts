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

/** Reads the starred-id set. Returns empty on any storage failure — a private
 *  bookmark is never worth breaking a list render over (Safari private mode
 *  throws on `localStorage` access, and a hand-edited value can be non-JSON). */
export function readStars(workspaceId: string): Set<string> {
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
	} catch {
		// Quota or private-mode failure — the in-memory set stays correct for
		// this session, which is the part the user can see.
	}
}
