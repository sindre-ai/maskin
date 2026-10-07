import type { MiddlewareHandler } from 'hono'
import { logger } from '../lib/logger'
import { type RuntimeHealth, runtimeHealth } from '../lib/runtime-health'

/** Requests at or above this are logged (rate-limited) as `Slow request`. */
export const SLOW_REQUEST_MS = 1_000

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const NUMERIC_SEGMENT_RE = /\/\d{3,}(?=\/|$)/g

/**
 * Collapses ids so timings aggregate per route instead of per resource, and so
 * a log line never carries a workspace, session or object id in the route.
 */
export function normalizeRoutePath(path: string): string {
	return path.replace(UUID_RE, ':id').replace(NUMERIC_SEGMENT_RE, '/:n').slice(0, 120)
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * Times every request and reports it three ways:
 *
 * - `Server-Timing` response header (visible in the browser's network panel and
 *   HAR exports): total handler time, plus the event-loop lag and in-flight
 *   request count at the moment the response was produced. Comparing `app`
 *   against the Cloudflare Worker's wall time separates origin work from
 *   network and edge time; comparing it against Postgres execution time
 *   (pg_stat_statements) separates database work from everything else.
 * - Per-route aggregates, emitted periodically by `RuntimeHealth`.
 * - A `Slow request` warning for anything over `SLOW_REQUEST_MS`.
 *
 * Streaming responses (SSE) are excluded: their handler returns as soon as the
 * stream opens, so the number would not be a latency.
 */
export function requestTiming(
	health: RuntimeHealth = runtimeHealth,
	options: { slowMs?: number } = {},
): MiddlewareHandler {
	const slowMs = options.slowMs ?? SLOW_REQUEST_MS

	return async (c, next) => {
		const start = performance.now()
		health.requestStarted()

		try {
			await next()
		} catch (err) {
			// Hono normally turns handler errors into a response, so this is a
			// middleware-level failure. Don't leak the in-flight count over it.
			health.requestFinished({ route: '', durationMs: 0, slow: false, stream: true })
			throw err
		}

		const durationMs = performance.now() - start
		const contentType = c.res?.headers.get('content-type') ?? ''
		const stream = contentType.startsWith('text/event-stream')
		const slow = durationMs >= slowMs
		const route = normalizeRoutePath(c.req.path)
		const inFlight = health.inFlightNow
		const loopLagMs = health.loopLagP99Ms()
		health.requestFinished({ route, durationMs, slow, stream })

		if (stream) return

		try {
			c.header(
				'Server-Timing',
				[
					`app;dur=${round1(durationMs)}`,
					`loop-p99;desc="event-loop p99 lag (ms)";dur=${round1(loopLagMs)}`,
					`in-flight;desc="requests in flight";dur=${inFlight}`,
				].join(', '),
			)
		} catch {
			// A response with immutable headers must never fail the request over a
			// diagnostic header.
		}

		if (slow && health.allowSlowLog()) {
			logger.warn('Slow request', {
				method: c.req.method,
				route,
				status: c.res.status,
				duration_ms: round1(durationMs),
				in_flight: inFlight,
				loop_lag_p99_ms: round1(loopLagMs),
			})
		}
	}
}
