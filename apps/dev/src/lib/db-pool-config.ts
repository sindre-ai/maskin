import { DEFAULT_POOL_SIZE } from '@maskin/db'

/**
 * Supabase's connection limit is shared with its own services (auth, storage, realtime), so the
 * app takes at most this many. Set DB_POOL_SIZE to change it; a value that is not a whole number
 * in range falls back to the default.
 */
export const APP_DB_POOL_SIZE_DEFAULT = 20
export const APP_DB_POOL_SIZE_MAX = 60

/**
 * Queries waiting on the pool, as a multiple of the pool size, past which new reads are refused
 * (see middleware/db-load-shed.ts). Set DB_SHED_AT to give an absolute count instead.
 */
export const SHED_QUERIES_PER_CONNECTION = 10

function wholeNumberInRange(raw: string | undefined, min: number, max: number): number | null {
	if (raw === undefined || raw.trim() === '') return null
	const n = Number(raw)
	return Number.isInteger(n) && n >= min && n <= max ? n : null
}

export function resolveDbPoolConfig(env: Record<string, string | undefined>) {
	const poolSize =
		wholeNumberInRange(env.DB_POOL_SIZE, 1, APP_DB_POOL_SIZE_MAX) ?? APP_DB_POOL_SIZE_DEFAULT
	const shedAt =
		wholeNumberInRange(env.DB_SHED_AT, poolSize, 100_000) ?? poolSize * SHED_QUERIES_PER_CONNECTION
	return { poolSize: poolSize || DEFAULT_POOL_SIZE, shedAt }
}
