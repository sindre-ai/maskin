// Short per-person cache for the four hot list reads: the actors list, the chat list, the unread
// chat list (the same route with unread_only) and For You. Every open tab and every SSE event
// refetches these, so a burst of identical reads from one person otherwise runs the same queries
// over and over (the actors list alone was 52k calls in 7 days).
//
// Modelled on billing-usage-cache.ts: the entry holds the in-flight promise as well as the settled
// value, so concurrent identical requests share one computation.
//
// Safety rules (CTO, 3 Nov 2026):
//   - Keyed by actor, workspace, route and the full query string. One person's body can never
//     answer another person, another workspace, or another filter.
//   - Authorization runs before the cache is read. The middleware sits after authMiddleware, which
//     has already proven the actor is a member of the workspace in X-Workspace-Id. For You asks the
//     handler to check a second actor (for_actor_id), so that form is never cached.
//   - A person's own write clears their entries (`evictListReadsFor`), so their next read shows the
//     change. Other people's entries may stay until the TTL passes. One write by someone else
//     changes who may read: removing a chat member evicts that member's entries as well.
//
// The cache is per process. Production runs one API process (docker-compose.prod.yml); a second
// instance would not see this process's evictions, and the TTL is the fallback there.

export const LIST_READ_CACHE_TTL_MS = 3_000

const CACHE_MAP_CAP = 500
// A body this big is not worth holding; the read goes through uncached.
const MAX_CACHED_BODY_BYTES = 1_000_000

export type ListReadSnapshot = { status: number; body: string; headers: Record<string, string> }

// null means the leader's response was not cacheable; followers run the handler themselves.
type Entry = { actorId: string; expiresAt: number; value: Promise<ListReadSnapshot | null> }
const entries = new Map<string, Entry>()

export function listReadCacheKey(
	actorId: string,
	workspaceId: string,
	path: string,
	search: string,
): string {
	const params = new URLSearchParams(search)
	params.sort()
	return `${actorId}|${workspaceId}|${path}?${params.toString()}`
}

export function isCacheableBody(body: string): boolean {
	return body.length <= MAX_CACHED_BODY_BYTES
}

// Returns the cached (or in-flight) read for this key, or registers `compute` as the leader.
export function cachedListRead(
	key: string,
	actorId: string,
	compute: () => Promise<ListReadSnapshot | null>,
	now: number = Date.now(),
): Promise<ListReadSnapshot | null> {
	const existing = entries.get(key)
	if (existing && existing.expiresAt > now) return existing.value

	const value = compute()
	const entry: Entry = { actorId, expiresAt: now + LIST_READ_CACHE_TTL_MS, value }
	entries.set(key, entry)
	// A response that was not cacheable, or a failed read, must not be served for the rest of the window.
	const dropIfCurrent = () => {
		if (entries.get(key) === entry) entries.delete(key)
	}
	value.then((snapshot) => {
		if (snapshot === null) dropIfCurrent()
	}, dropIfCurrent)

	if (entries.size > CACHE_MAP_CAP) {
		for (const [k, e] of entries) {
			if (e.expiresAt <= now) entries.delete(k)
		}
	}
	return value
}

// Drops every entry for one person, in every workspace. Call it after a write by that person (the
// middleware does this for every non-GET request), and for anyone whose access a write just changed.
export function evictListReadsFor(actorId: string): void {
	for (const [key, entry] of entries) {
		if (entry.actorId === actorId) entries.delete(key)
	}
}

// Test-only reset so cases don't see each other's cached reads.
export function _resetListReadCache(): void {
	entries.clear()
}
