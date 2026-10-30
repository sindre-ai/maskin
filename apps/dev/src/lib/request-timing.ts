import { AsyncLocalStorage } from 'node:async_hooks'
import type { MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import { logger } from './logger'

/**
 * Per-route API timing, to rank which endpoints cost the most (total time and database time).
 *
 * Requests are summed into one log line per route per minute (`api_route_timing`) instead of one
 * line each, so the volume stays flat under load. A request that is slow in total or in the
 * database also gets its own line (`api_slow_request`) so a slow query can be tied to a route.
 * Routes are logged by pattern (`/api/objects/:id`), never the raw URL.
 *
 * Database time is the sum of every query drizzle sent while handling the request, measured by
 * `onQuery` in `createDb` and attributed through AsyncLocalStorage. It includes waiting for a
 * pooled connection.
 *
 * Event streams are kept apart (`stream: true`): their request stays open for the whole
 * connection, so they are recorded when the client disconnects and carry the database reads done
 * while it was open (the Last-Event-ID replay and per-frame reads). Frames sent for events that
 * arrive from the live bridge run outside the request and are not attributed.
 */

const FLUSH_INTERVAL_MS = 60_000
const SLOW_REQUEST_MS = 1_000
const SLOW_DB_MS = 500
const SKIPPED_PATHS = new Set(['/api/health'])

interface RequestTiming {
	dbMs: number
	dbQueries: number
}

interface Bucket {
	requests: number
	errors5xx: number
	totalMs: number
	maxMs: number
	dbMs: number
	dbMaxMs: number
	dbQueries: number
}

const requestStore = new AsyncLocalStorage<RequestTiming>()
const buckets = new Map<string, Bucket & { method: string; route: string; stream: boolean }>()
let flushTimer: ReturnType<typeof setInterval> | undefined

/** Passed to `createDb` as `onQuery`. A no-op for queries outside a request. */
export function recordDbTime(ms: number): void {
	const timing = requestStore.getStore()
	if (!timing) return
	timing.dbMs += ms
	timing.dbQueries++
}

const round = (n: number) => Math.round(n * 10) / 10

function record(
	method: string,
	route: string,
	status: number,
	stream: boolean,
	totalMs: number,
	timing: RequestTiming,
) {
	const key = `${method} ${route} ${stream}`
	let bucket = buckets.get(key)
	if (!bucket) {
		bucket = {
			method,
			route,
			stream,
			requests: 0,
			errors5xx: 0,
			totalMs: 0,
			maxMs: 0,
			dbMs: 0,
			dbMaxMs: 0,
			dbQueries: 0,
		}
		buckets.set(key, bucket)
	}
	bucket.requests++
	if (status >= 500) bucket.errors5xx++
	bucket.totalMs += totalMs
	bucket.maxMs = Math.max(bucket.maxMs, totalMs)
	bucket.dbMs += timing.dbMs
	bucket.dbMaxMs = Math.max(bucket.dbMaxMs, timing.dbMs)
	bucket.dbQueries += timing.dbQueries

	// A stream's total is the connection lifetime, so only its database time can make it slow.
	if ((!stream && totalMs >= SLOW_REQUEST_MS) || timing.dbMs >= SLOW_DB_MS) {
		logger.info('api_slow_request', {
			method,
			route,
			status,
			stream,
			total_ms: round(totalMs),
			db_ms: round(timing.dbMs),
			db_queries: timing.dbQueries,
		})
	}

	if (!flushTimer) {
		flushTimer = setInterval(flushRouteTiming, FLUSH_INTERVAL_MS)
		flushTimer.unref()
	}
}

/** Writes one `api_route_timing` line per route seen since the last flush. */
export function flushRouteTiming(): void {
	for (const b of buckets.values()) {
		logger.info('api_route_timing', {
			method: b.method,
			route: b.route,
			stream: b.stream,
			window_s: FLUSH_INTERVAL_MS / 1000,
			requests: b.requests,
			errors_5xx: b.errors5xx,
			total_ms_sum: round(b.totalMs),
			total_ms_avg: round(b.totalMs / b.requests),
			total_ms_max: round(b.maxMs),
			db_ms_sum: round(b.dbMs),
			db_ms_avg: round(b.dbMs / b.requests),
			db_ms_max: round(b.dbMaxMs),
			db_queries: b.dbQueries,
		})
	}
	buckets.clear()
}

export function requestTiming(): MiddlewareHandler {
	return async (c, next) => {
		if (SKIPPED_PATHS.has(c.req.path)) return next()

		const timing: RequestTiming = { dbMs: 0, dbQueries: 0 }
		const start = performance.now()
		await requestStore.run(timing, next)

		const method = c.req.method
		// No index: Hono leaves the route index on the last handler that ran, which is the one that
		// answered. Index -1 is the last *registered* match, which is always the static/SPA catch-all.
		const route = routePath(c) || 'unmatched'
		const status = c.res.status
		const stream = c.res.headers.get('content-type')?.startsWith('text/event-stream') ?? false
		if (!stream) {
			record(method, route, status, false, performance.now() - start, timing)
			return
		}

		const signal = c.req.raw.signal
		const finish = () => record(method, route, status, true, performance.now() - start, timing)
		if (signal.aborted) finish()
		else signal.addEventListener('abort', finish, { once: true })
	}
}
