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
 *
 * Open streams are counted next to that (`api_open_streams`): one line when a stream connects and
 * one when it disconnects, each with the number open afterwards, plus one `window` line per route
 * per minute with the open count at the flush and the peak seen during that minute. Counts only,
 * keyed by the route pattern, never by person, workspace or URL.
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

interface StreamGauge {
	method: string
	route: string
	open: number
	/** Highest `open` since the last flush. Starts each window at the number still open. */
	peak: number
	connects: number
	disconnects: number
}

const requestStore = new AsyncLocalStorage<RequestTiming>()
const buckets = new Map<string, Bucket & { method: string; route: string; stream: boolean }>()
const streamGauges = new Map<string, StreamGauge>()
let flushTimer: ReturnType<typeof setInterval> | undefined

/** Passed to `createDb` as `onQuery`. A no-op for queries outside a request. */
export function recordDbTime(ms: number): void {
	const timing = requestStore.getStore()
	if (!timing) return
	timing.dbMs += ms
	timing.dbQueries++
}

const round = (n: number) => Math.round(n * 10) / 10

function ensureFlushTimer() {
	if (flushTimer) return
	flushTimer = setInterval(flushRouteTiming, FLUSH_INTERVAL_MS)
	flushTimer.unref()
}

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

	ensureFlushTimer()
}

function streamConnected(method: string, route: string) {
	const key = `${method} ${route}`
	let gauge = streamGauges.get(key)
	if (!gauge) {
		gauge = { method, route, open: 0, peak: 0, connects: 0, disconnects: 0 }
		streamGauges.set(key, gauge)
	}
	gauge.open++
	gauge.connects++
	gauge.peak = Math.max(gauge.peak, gauge.open)
	logger.info('api_open_streams', { method, route, event: 'connect', open: gauge.open })
	ensureFlushTimer()
}

function streamDisconnected(method: string, route: string) {
	const gauge = streamGauges.get(`${method} ${route}`)
	if (!gauge) return
	gauge.open = Math.max(0, gauge.open - 1)
	gauge.disconnects++
	logger.info('api_open_streams', { method, route, event: 'disconnect', open: gauge.open })
}

/**
 * Writes one `api_route_timing` line per route seen since the last flush, and one
 * `api_open_streams` window line per stream route that had a stream open or moving.
 */
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

	for (const [key, g] of streamGauges) {
		if (g.open > 0 || g.connects > 0 || g.disconnects > 0) {
			logger.info('api_open_streams', {
				method: g.method,
				route: g.route,
				event: 'window',
				window_s: FLUSH_INTERVAL_MS / 1000,
				open: g.open,
				peak: g.peak,
				connects: g.connects,
				disconnects: g.disconnects,
			})
		}
		// The next window starts from what is still open. A route with nothing open and nothing
		// moving is dropped, so the map cannot grow past the stream routes in use.
		if (g.open === 0) streamGauges.delete(key)
		else {
			g.peak = g.open
			g.connects = 0
			g.disconnects = 0
		}
	}
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
		if (signal.aborted) {
			finish()
			return
		}
		streamConnected(method, route)
		signal.addEventListener(
			'abort',
			() => {
				streamDisconnected(method, route)
				finish()
			},
			{ once: true },
		)
	}
}
