/**
 * Short-lived, per-process cache for the two lookups `authMiddleware` runs on
 * every request: API key → actor, and (actor, workspace) → membership.
 *
 * Why: those two queries sit in front of every handler, and a page load fires a
 * dozen requests in parallel, so one tab alone made ~25 sequential round trips
 * before any real work started (~18M lookups in production stats, each paying
 * pool-wait + network). Caching the in-flight promise also collapses the
 * parallel burst into one query per key.
 *
 * Revocation: a revoked key or removed member stays valid for up to the TTL
 * unless evicted. The routes that rotate a key, delete an actor or remove a
 * member call `evictApiKey` / `evictActor` / `evictMembership`, so the common
 * cases take effect immediately; any other path (e.g. a direct DB edit) waits
 * out the TTL. Only positive results are cached, so a key that was just created
 * is never shadowed by a stale "invalid" answer, and failed lookups are never
 * cached.
 */

export const DEFAULT_AUTH_CACHE_TTL_MS = 10_000
const MAX_ENTRIES = 5_000

interface Entry<T> {
	expiresAt: number
	value: Promise<T>
}

export class TtlPromiseCache<T> {
	private entries = new Map<string, Entry<T>>()

	constructor(
		private ttlMs: number,
		private maxEntries: number = MAX_ENTRIES,
	) {}

	/** Returns the cached (or in-flight) value, loading it on a miss. A ttl of 0 disables caching. */
	get(
		key: string,
		load: () => Promise<T>,
		isCacheable: (value: T) => boolean,
		now: number = Date.now(),
	): Promise<T> {
		if (this.ttlMs <= 0) return load()

		const existing = this.entries.get(key)
		if (existing && existing.expiresAt > now) return existing.value

		const value = load()
		const entry: Entry<T> = { expiresAt: now + this.ttlMs, value }
		this.entries.set(key, entry)
		// Settled but not cacheable (null / false) or failed: drop it so the next
		// caller asks the database again. Callers already awaiting `value` still
		// share this one lookup.
		value.then(
			(v) => {
				if (!isCacheable(v) && this.entries.get(key) === entry) this.entries.delete(key)
			},
			() => {
				if (this.entries.get(key) === entry) this.entries.delete(key)
			},
		)

		if (this.entries.size > this.maxEntries) this.sweep(now)
		return value
	}

	delete(key: string): void {
		this.entries.delete(key)
	}

	deleteWhere(predicate: (key: string) => boolean): void {
		for (const key of this.entries.keys()) {
			if (predicate(key)) this.entries.delete(key)
		}
	}

	clear(): void {
		this.entries.clear()
	}

	private sweep(now: number): void {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(key)
		}
		// Still over the cap with nothing expired: evict oldest-first (Map keeps
		// insertion order) rather than growing without bound.
		for (const key of this.entries.keys()) {
			if (this.entries.size <= this.maxEntries) break
			this.entries.delete(key)
		}
	}
}

export interface AuthCaches {
	apiKeys: TtlPromiseCache<{ actorId: string; type: string } | null>
	memberships: TtlPromiseCache<boolean>
}

// Every live cache, so eviction reaches whichever middleware instance holds the
// entry. Production creates exactly one; tests create many short-lived ones.
const registry = new Set<AuthCaches>()

export function createAuthCaches(ttlMs: number): AuthCaches {
	const caches: AuthCaches = {
		apiKeys: new TtlPromiseCache(ttlMs),
		memberships: new TtlPromiseCache(ttlMs),
	}
	registry.add(caches)
	return caches
}

/**
 * TTL from `AUTH_CACHE_TTL_MS` (0 disables). Anything unparseable falls back to
 * the default instead of silently disabling revocation lag protection.
 */
export function resolveAuthCacheTtlMs(raw: string | undefined = process.env.AUTH_CACHE_TTL_MS) {
	if (raw === undefined || raw.trim() === '') return DEFAULT_AUTH_CACHE_TTL_MS
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_AUTH_CACHE_TTL_MS
}

/** Call after rotating or revoking an API key. */
export function evictApiKey(apiKey: string): void {
	for (const caches of registry) caches.apiKeys.delete(apiKey)
}

/** Call after deleting an actor or changing which actor a key resolves to. */
export function evictActor(actorId: string): void {
	for (const caches of registry) {
		caches.apiKeys.clear()
		caches.memberships.deleteWhere((key) => key.startsWith(`${actorId}|`))
	}
}

/** Call after removing a member from a workspace. */
export function evictMembership(actorId: string, workspaceId: string): void {
	for (const caches of registry) caches.memberships.delete(`${actorId}|${workspaceId}`)
}
