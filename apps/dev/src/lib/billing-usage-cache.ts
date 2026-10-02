// Short per-process cache for `GET /api/billing/usage`.
//
// Every open tab refetches usage when a session ends, and each read sums
// the workspace's plan sessions for the period. A burst of session events
// across N tabs would otherwise run that scan N times. The cache holds the
// in-flight promise as well as the settled value, so concurrent identical
// requests share one computation.
//
// Keyed per actor AND workspace, never shared wider: the response carries an
// actor-scoped flag (the LinkedIn add-on line), and a workspace id alone would
// let one member's response answer another's. Callers sit behind authMiddleware,
// which has already proven the actor is a member of the workspace.
//
// Freshness does not depend on the TTL being shorter than the web app's refetch
// window: `recordEvent` evicts a workspace's entries whenever it records a
// session event that moves the number (BILLING_MOVING_SESSION_ACTIONS in
// lib/events/record-event.ts). Callers that record such an event inside a
// transaction evict again after it commits, because the eviction inside
// `recordEvent` runs before the commit and a racing read could re-cache the old
// value. The TTL bounds how stale the mid-session token/cost counters can get,
// since those change without an event. The cache is per process, so eviction
// does not reach a second app instance; the TTL is the fallback there.

export const BILLING_USAGE_CACHE_TTL_MS = 15_000

const CACHE_MAP_CAP = 1_000

type Entry = { expiresAt: number; value: Promise<unknown> }
const entries = new Map<string, Entry>()

export function cachedBillingUsage<T>(
	actorId: string,
	workspaceId: string,
	compute: () => Promise<T>,
	now: number = Date.now(),
): Promise<T> {
	const key = `${actorId}|${workspaceId}`
	const existing = entries.get(key)
	if (existing && existing.expiresAt > now) return existing.value as Promise<T>

	const value = compute()
	const entry: Entry = { expiresAt: now + BILLING_USAGE_CACHE_TTL_MS, value }
	entries.set(key, entry)
	// A failed read must not be served for the rest of the window.
	value.catch(() => {
		if (entries.get(key) === entry) entries.delete(key)
	})

	if (entries.size > CACHE_MAP_CAP) {
		for (const [k, e] of entries) {
			if (e.expiresAt <= now) entries.delete(k)
		}
	}
	return value
}

// Drops every actor's entry for one workspace. Call it after a write the usage
// response reflects and the caller refetches straight away (cancelling the
// subscription), so that refetch is not answered with the pre-write read. Inside
// a transaction, call it after the commit, not before.
export function evictBillingUsage(workspaceId: string): void {
	for (const key of entries.keys()) {
		if (key.endsWith(`|${workspaceId}`)) entries.delete(key)
	}
}

// Test-only reset so cases don't see each other's cached reads.
export function _resetBillingUsageCache(): void {
	entries.clear()
}
