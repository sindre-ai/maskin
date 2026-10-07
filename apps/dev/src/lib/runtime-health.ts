import { monitorEventLoopDelay } from 'node:perf_hooks'
import { logger } from './logger'

/**
 * Process-level timing signals for the API: how late the Node event loop is
 * running, how many requests are in flight, and which routes are taking time.
 *
 * Why this exists: Postgres execution time was measured (pg_stat_statements)
 * and is small, yet user-facing routes still sometimes average several
 * seconds. Whatever fills that gap — a blocked event loop, queueing for a pool
 * connection, a slow client — is invisible without a view from inside the
 * process. This provides it with no new infrastructure: the numbers are
 * logged as structured JSON (stdout, so the existing log shipping picks them
 * up) and attached to each response as `Server-Timing`.
 *
 * Counters only here; the timer starts in `start()` (called from index.ts), so
 * building the app in tests or for the OpenAPI export has no side effects.
 */

export const HEARTBEAT_INTERVAL_MS = 30_000
/** A route-timing summary is emitted every this many heartbeats (5 min). */
const ROUTE_REPORT_EVERY = 10
/** Event-loop p99 lag above this in a window raises a warning. */
const LAG_WARN_P99_MS = 250
const MAX_ROUTES_TRACKED = 200
const ROUTES_REPORTED = 15
/** Slow-request log lines per minute; keeps a bad minute from flooding the log. */
const MAX_SLOW_LOGS_PER_MINUTE = 30

interface RouteStats {
	count: number
	totalMs: number
	maxMs: number
	slow: number
}

const nsToMs = (ns: number) => (Number.isFinite(ns) && ns > 0 && ns < 1e15 ? ns / 1e6 : 0)
const round1 = (n: number) => Math.round(n * 10) / 10

export class RuntimeHealth {
	private histogram = monitorEventLoopDelay({ resolution: 10 })
	private timer: ReturnType<typeof setInterval> | null = null
	private inFlight = 0
	private inFlightPeak = 0
	private requests = 0
	private slowRequests = 0
	private routes = new Map<string, RouteStats>()
	private heartbeats = 0
	private windowStartedAt = Date.now()
	private slowLogMinute = 0
	private slowLogCount = 0

	start(intervalMs: number = HEARTBEAT_INTERVAL_MS): void {
		if (this.timer) return
		this.histogram.enable()
		this.windowStartedAt = Date.now()
		this.timer = setInterval(() => this.report(), intervalMs)
		// Never keep the process alive just to report on it.
		this.timer.unref()
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		this.histogram.disable()
	}

	requestStarted(): void {
		this.inFlight++
		if (this.inFlight > this.inFlightPeak) this.inFlightPeak = this.inFlight
	}

	requestFinished(info: { route: string; durationMs: number; slow: boolean; stream: boolean }) {
		this.inFlight = Math.max(0, this.inFlight - 1)
		// An open stream's "duration" is how long the handler took to return its
		// first byte, not a latency — counting it would only distort the averages.
		if (info.stream) return
		this.requests++
		if (info.slow) this.slowRequests++

		let stats = this.routes.get(info.route)
		if (!stats) {
			if (this.routes.size >= MAX_ROUTES_TRACKED) return
			stats = { count: 0, totalMs: 0, maxMs: 0, slow: 0 }
			this.routes.set(info.route, stats)
		}
		stats.count++
		stats.totalMs += info.durationMs
		if (info.durationMs > stats.maxMs) stats.maxMs = info.durationMs
		if (info.slow) stats.slow++
	}

	/** True while under the per-minute cap on slow-request log lines. */
	allowSlowLog(now: number = Date.now()): boolean {
		const minute = Math.floor(now / 60_000)
		if (minute !== this.slowLogMinute) {
			this.slowLogMinute = minute
			this.slowLogCount = 0
		}
		this.slowLogCount++
		return this.slowLogCount <= MAX_SLOW_LOGS_PER_MINUTE
	}

	get inFlightNow(): number {
		return this.inFlight
	}

	/** p99 event-loop lag over the current window, in milliseconds. */
	loopLagP99Ms(): number {
		return nsToMs(this.histogram.percentile(99))
	}

	report(): void {
		const windowSeconds = Math.round((Date.now() - this.windowStartedAt) / 1000)
		const mem = process.memoryUsage()
		const p50 = nsToMs(this.histogram.percentile(50))
		const p99 = nsToMs(this.histogram.percentile(99))
		const max = nsToMs(this.histogram.max)

		// stdout only (debug never goes to Sentry): this runs every 30 s.
		logger.debug('runtime_health', {
			window_s: windowSeconds,
			loop_lag_p50_ms: round1(p50),
			loop_lag_p99_ms: round1(p99),
			loop_lag_max_ms: round1(max),
			in_flight: this.inFlight,
			in_flight_peak: this.inFlightPeak,
			requests: this.requests,
			slow_requests: this.slowRequests,
			rss_mb: Math.round(mem.rss / 1048576),
			heap_used_mb: Math.round(mem.heapUsed / 1048576),
		})

		if (p99 > LAG_WARN_P99_MS) {
			logger.warn('Event loop lag is high', {
				window_s: windowSeconds,
				loop_lag_p99_ms: round1(p99),
				loop_lag_max_ms: round1(max),
				in_flight_peak: this.inFlightPeak,
			})
		}

		this.heartbeats++
		if (this.heartbeats % ROUTE_REPORT_EVERY === 0) this.reportRoutes()

		this.histogram.reset()
		this.inFlightPeak = this.inFlight
		this.requests = 0
		this.slowRequests = 0
		this.windowStartedAt = Date.now()
	}

	private reportRoutes(): void {
		const top = [...this.routes.entries()]
			.sort((a, b) => b[1].totalMs - a[1].totalMs)
			.slice(0, ROUTES_REPORTED)
			.map(([route, s]) => ({
				route,
				count: s.count,
				avg_ms: round1(s.totalMs / s.count),
				max_ms: round1(s.maxMs),
				slow: s.slow,
			}))
		if (top.length > 0) logger.debug('route_timing', { routes: top })
		this.routes.clear()
	}
}

/** Shared by the request middleware and the heartbeat. */
export const runtimeHealth = new RuntimeHealth()
