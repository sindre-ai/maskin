import type { Database } from '@maskin/db'
import { apiRouteTimingMinutes } from '@maskin/db/schema'
import { lt, sql } from 'drizzle-orm'
import { logger } from './logger'

/**
 * Keeps the once-a-minute route timing numbers (see request-timing.ts) for 30 days, so the load per
 * route can be read over a week instead of only from the log tail.
 *
 * One row per minute, per route, per app build: counts and sums, no actor, workspace or URL. The
 * write is fire-and-forget from the timing flush. If it fails it is logged and dropped; a request
 * never waits for it and never fails because of it.
 */

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CLEANUP_EVERY_MS = 60 * 60 * 1000
const CLEANUP_BATCH = 5_000
const CLEANUP_MAX_BATCHES = 20

/** One flushed bucket. Same numbers as the `api_route_timing` log line, as sums. */
export interface RouteTimingRow {
	method: string
	route: string
	stream: boolean
	requests: number
	slowRequests: number
	errors5xx: number
	totalMs: number
	dbMs: number
	dbQueries: number
}

export type RouteTimingSink = (rows: RouteTimingRow[], now?: Date) => void

/**
 * The build is the commit the image was built from. The web bundle reports the same value to
 * Faro as VITE_MASKIN_COMMIT_SHA, and it stays in the API image's environment.
 */
export function currentBuild(env: NodeJS.ProcessEnv = process.env): string {
	return env.VITE_MASKIN_COMMIT_SHA || env.SOURCE_COMMIT || 'unknown'
}

export function createRouteTimingStore(
	db: Database,
	build: string = currentBuild(),
): RouteTimingSink {
	let lastCleanupAt = 0
	let writing = false

	async function write(rows: RouteTimingRow[], now: Date) {
		const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
		const t = apiRouteTimingMinutes
		await db
			.insert(t)
			.values(
				rows.map((r) => ({
					minute,
					build,
					method: r.method,
					route: r.route,
					stream: r.stream,
					requests: r.requests,
					slowRequests: r.slowRequests,
					errors5xx: r.errors5xx,
					totalMsSum: r.totalMs,
					dbMsSum: r.dbMs,
					dbQueries: r.dbQueries,
				})),
			)
			.onConflictDoUpdate({
				target: [t.minute, t.build, t.method, t.route, t.stream],
				set: {
					requests: sql`${t.requests} + excluded.requests`,
					slowRequests: sql`${t.slowRequests} + excluded.slow_requests`,
					errors5xx: sql`${t.errors5xx} + excluded.errors_5xx`,
					totalMsSum: sql`${t.totalMsSum} + excluded.total_ms_sum`,
					dbMsSum: sql`${t.dbMsSum} + excluded.db_ms_sum`,
					dbQueries: sql`${t.dbQueries} + excluded.db_queries`,
				},
			})
	}

	// Short slices, so one cleanup never holds a long lock on the rows the next flush writes to.
	async function cleanup(now: number) {
		const cutoff = new Date(now - RETENTION_MS)
		const t = apiRouteTimingMinutes
		for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
			const deleted = await db
				.delete(t)
				.where(
					sql`(${t.minute}, ${t.build}, ${t.method}, ${t.route}, ${t.stream}) in (
						select ${t.minute}, ${t.build}, ${t.method}, ${t.route}, ${t.stream}
						from ${t} where ${lt(t.minute, cutoff)} limit ${CLEANUP_BATCH}
					)`,
				)
				.returning({ minute: t.minute })
			if (deleted.length < CLEANUP_BATCH) return
		}
	}

	return (rows, now = new Date()) => {
		if (rows.length === 0 || writing) {
			// A flush that overlaps a slow write is skipped rather than queued behind it.
			if (writing && rows.length > 0)
				logger.warn('api_route_timing_store skipped', { rows: rows.length })
			return
		}
		writing = true
		void (async () => {
			try {
				await write(rows, now)
				if (now.getTime() - lastCleanupAt >= CLEANUP_EVERY_MS) {
					lastCleanupAt = now.getTime()
					await cleanup(now.getTime())
				}
			} catch (err) {
				logger.warn('api_route_timing_store failed', {
					error: err instanceof Error ? err.message : String(err),
					rows: rows.length,
				})
			} finally {
				writing = false
			}
		})()
	}
}
