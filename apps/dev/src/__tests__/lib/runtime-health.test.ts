import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import { RuntimeHealth } from '../../lib/runtime-health'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Blocks the event loop for `ms`, the way a long synchronous task would. */
function blockLoop(ms: number) {
	const until = Date.now() + ms
	while (Date.now() < until) {
		// spin
	}
}

describe('RuntimeHealth', () => {
	let health: RuntimeHealth
	let debug: ReturnType<typeof vi.spyOn>
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		health = new RuntimeHealth()
		debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
		warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
	})

	afterEach(() => {
		health.stop()
		vi.restoreAllMocks()
	})

	const healthLogs = () => debug.mock.calls.filter(([message]) => message === 'runtime_health')

	it('logs a runtime_health line with loop lag, in-flight and memory fields', () => {
		health.report()

		expect(healthLogs()).toHaveLength(1)
		expect(healthLogs()[0]?.[1]).toEqual(
			expect.objectContaining({
				window_s: expect.any(Number),
				loop_lag_p50_ms: expect.any(Number),
				loop_lag_p99_ms: expect.any(Number),
				loop_lag_max_ms: expect.any(Number),
				in_flight: 0,
				in_flight_peak: 0,
				requests: 0,
				slow_requests: 0,
				rss_mb: expect.any(Number),
				heap_used_mb: expect.any(Number),
			}),
		)
	})

	it('measures a blocked event loop and warns when the lag is high', async () => {
		health.start(60_000)
		await sleep(60)
		blockLoop(400)
		await sleep(60)

		health.report()

		const fields = healthLogs()[0]?.[1] as Record<string, number>
		expect(fields.loop_lag_max_ms).toBeGreaterThanOrEqual(300)
		expect(warn).toHaveBeenCalledWith(
			'Event loop lag is high',
			expect.objectContaining({ loop_lag_p99_ms: expect.any(Number) }),
		)
	})

	it('does not warn about lag when the loop is healthy', async () => {
		health.start(60_000)
		await sleep(80)

		health.report()

		expect(warn).not.toHaveBeenCalled()
	})

	it('resets the window after each report', () => {
		health.requestStarted()
		health.requestFinished({ route: '/api/a', durationMs: 10, slow: false, stream: false })
		health.report()
		health.report()

		expect(healthLogs()[0]?.[1]).toMatchObject({ requests: 1 })
		expect(healthLogs()[1]?.[1]).toMatchObject({ requests: 0 })
	})

	it('summarizes the busiest routes every tenth heartbeat', () => {
		health.requestFinished({ route: '/api/light', durationMs: 5, slow: false, stream: false })
		health.requestFinished({ route: '/api/heavy', durationMs: 900, slow: false, stream: false })
		health.requestFinished({ route: '/api/heavy', durationMs: 1500, slow: true, stream: false })

		for (let i = 0; i < 10; i++) health.report()

		const summaries = debug.mock.calls.filter(([message]) => message === 'route_timing')
		expect(summaries).toHaveLength(1)
		const routes = (summaries[0]?.[1] as { routes: Array<Record<string, unknown>> }).routes
		expect(routes[0]).toEqual({
			route: '/api/heavy',
			count: 2,
			avg_ms: 1200,
			max_ms: 1500,
			slow: 1,
		})
		expect(routes[1]).toMatchObject({ route: '/api/light', count: 1 })

		// The window clears after a summary.
		for (let i = 0; i < 10; i++) health.report()
		expect(debug.mock.calls.filter(([message]) => message === 'route_timing')).toHaveLength(1)
	})

	it('bounds how many distinct routes it tracks', () => {
		for (let i = 0; i < 500; i++) {
			health.requestFinished({ route: `/api/r${i}`, durationMs: 1, slow: false, stream: false })
		}

		for (let i = 0; i < 10; i++) health.report()

		const summary = debug.mock.calls.find(([message]) => message === 'route_timing')
		expect((summary?.[1] as { routes: unknown[] }).routes.length).toBeLessThanOrEqual(15)
	})

	it('caps slow-request log lines to 30 per minute and resets the next minute', () => {
		const t = Date.UTC(2026, 9, 7, 10, 0, 5)
		const allowed = Array.from({ length: 35 }, () => health.allowSlowLog(t)).filter(Boolean)
		expect(allowed).toHaveLength(30)

		expect(health.allowSlowLog(t + 60_000)).toBe(true)
	})
})
