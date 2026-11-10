/**
 * Supabase's connection limit is shared with its own services (auth, storage, realtime), so the
 * app takes at most this many. Set DB_POOL_SIZE to change it; a value that is not a whole number
 * in range falls back to the default.
 */
export const APP_DB_POOL_SIZE_DEFAULT = 20
export const APP_DB_POOL_SIZE_MAX = 60

/**
 * A query that has waited this long for its answer is "stalled". A healthy query answers in
 * milliseconds, so a queue of them behind the pool is what a backed-up database looks like.
 */
export const STALLED_QUERY_AFTER_MS = 2_000

function wholeNumberInRange(raw: string | undefined, min: number, max: number): number | null {
	if (raw === undefined || raw.trim() === '') return null
	const n = Number(raw)
	return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/**
 * `shedAt` is how many stalled queries at once make the server refuse new reads (see
 * middleware/db-load-shed.ts); by default a pool's worth. DB_SHED_AT sets it, and a very large
 * value turns shedding off.
 */
export function resolveDbPoolConfig(env: Record<string, string | undefined>) {
	const poolSize =
		wholeNumberInRange(env.DB_POOL_SIZE, 1, APP_DB_POOL_SIZE_MAX) ?? APP_DB_POOL_SIZE_DEFAULT
	const shedAt = wholeNumberInRange(env.DB_SHED_AT, 1, 1_000_000) ?? poolSize
	return { poolSize, shedAt }
}
