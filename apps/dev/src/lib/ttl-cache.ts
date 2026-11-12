/**
 * A small in-process cache for an expensive read that many requests ask for at once.
 *
 * Two things protect the database: a result is kept for `ttlMs`, and callers that arrive while
 * it is being loaded share that one load instead of each running the query (a burst of tabs
 * refetching the same list becomes one query). A failed load is not kept, so the next caller
 * tries again. In-process on purpose, like the other guards here: the deployment is a single
 * instance, and a stale answer for a few seconds is the price, so use it only for reads whose
 * clients already refetch on a timer. The map is capped so keys cannot grow without bound.
 */
export interface TtlCache<T> {
	get(key: string, load: () => Promise<T>, now?: number): Promise<T>
	/** Drops one key, or everything. For a write that must show at once, and for tests. */
	invalidate(key?: string): void
}

export function createTtlCache<T>(options: { ttlMs: number; maxEntries?: number }): TtlCache<T> {
	const { ttlMs, maxEntries = 2_000 } = options
	const entries = new Map<string, { expiresAt: number; value: T }>()
	const loading = new Map<string, Promise<T>>()

	return {
		get(key, load, now = Date.now()) {
			const hit = entries.get(key)
			if (hit && hit.expiresAt > now) return Promise.resolve(hit.value)

			const inFlight = loading.get(key)
			if (inFlight) return inFlight

			const started = load().then(
				(value) => {
					loading.delete(key)
					if (entries.size >= maxEntries) {
						// Drop the oldest tenth; Map iteration order is insertion order.
						let toDrop = Math.ceil(maxEntries / 10)
						for (const k of entries.keys()) {
							entries.delete(k)
							if (--toDrop <= 0) break
						}
					}
					entries.delete(key)
					entries.set(key, { expiresAt: Date.now() + ttlMs, value })
					return value
				},
				(error) => {
					loading.delete(key)
					throw error
				},
			)
			loading.set(key, started)
			return started
		},
		invalidate(key) {
			if (key === undefined) {
				entries.clear()
				return
			}
			entries.delete(key)
		},
	}
}
