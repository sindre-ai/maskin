import { createHash } from 'node:crypto'

/**
 * In-memory read cache for YouTube reads: 15 minutes, per process, never written to disk or the
 * database. Entries are keyed by integration id, tool and a hash of the arguments, so a reconnect
 * with a different Google account in the same workspace never sees the old account's channel.
 * A hit costs no quota. Lost on restart, which is fine: a read costs 1 unit.
 */
export const CACHE_TTL_MS = 15 * 60 * 1000

interface Entry {
	expiresAt: number
	value: unknown
}

const entries = new Map<string, Entry>()

/** Bumped by every purge. A read that started before a purge must not refill the cache after it. */
const purgeEpochs = new Map<string, number>()

export function getPurgeEpoch(integrationId: string): number {
	return purgeEpochs.get(integrationId) ?? 0
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, stable(v)]),
		)
	}
	return value
}

function cacheKey(integrationId: string, tool: string, args: unknown): string {
	const hash = createHash('sha256')
		.update(JSON.stringify(stable(args ?? {})))
		.digest('hex')
	return `${integrationId}:${tool}:${hash}`
}

export function getCachedRead(integrationId: string, tool: string, args: unknown): unknown {
	const key = cacheKey(integrationId, tool, args)
	const hit = entries.get(key)
	if (!hit) return undefined
	if (hit.expiresAt <= Date.now()) {
		entries.delete(key)
		return undefined
	}
	return hit.value
}

export function setCachedRead(
	integrationId: string,
	tool: string,
	args: unknown,
	value: unknown,
	/** getPurgeEpoch(integrationId) taken before the read started. A purge since then skips the write. */
	epoch?: number,
) {
	if (epoch !== undefined && epoch !== getPurgeEpoch(integrationId)) return
	const now = Date.now()
	for (const [key, entry] of entries) {
		if (entry.expiresAt <= now) entries.delete(key)
	}
	entries.set(cacheKey(integrationId, tool, args), { expiresAt: now + CACHE_TTL_MS, value })
}

/** Drop every cached read of one integration, and make reads already in flight skip the cache. */
export function purgeYoutubeCache(integrationId: string): void {
	purgeEpochs.set(integrationId, getPurgeEpoch(integrationId) + 1)
	const prefix = `${integrationId}:`
	for (const key of entries.keys()) {
		if (key.startsWith(prefix)) entries.delete(key)
	}
}

/** Test helper: empty the whole cache. */
export function clearYoutubeCache(): void {
	entries.clear()
	purgeEpochs.clear()
}
