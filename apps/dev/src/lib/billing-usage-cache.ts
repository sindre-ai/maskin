// Short per-process cache for `GET /api/billing/usage`.
//
// Every open tab refetches usage when a session ends, and each read scans all
// of the workspace's plan sessions for the period. A burst of session events
// across N tabs would otherwise run that scan N times. The cache holds the
// in-flight promise as well as the settled value, so concurrent identical
// requests share one computation.
//
// Keyed per actor AND workspace, never shared wider: the response carries an
// actor-scoped flag (the LinkedIn add-on line), and a workspace id alone would
// let one member's response answer another's. Callers sit behind authMiddleware,
// which has already proven the actor is a member of the workspace.
//
// The TTL has to stay below the web app's trailing refetch window
// (TRAILING_REFETCH_MS in apps/web/src/lib/sse-invalidation.ts, 5s): the app
// refetches usage a full window after a session event, so the snapshot it gets
// is guaranteed to postdate the event instead of being a cached pre-event read.

export const BILLING_USAGE_CACHE_TTL_MS = 2_000

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

// Test-only reset so cases don't see each other's cached reads.
export function _resetBillingUsageCache(): void {
	entries.clear()
}
