import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import { RuntimeHealth } from '../../lib/runtime-health'
import { normalizeRoutePath, requestTiming } from '../../middleware/request-timing'

const SESSION_ID = '4f0a1c3e-9b7d-4e2a-8c5f-1a2b3c4d5e6f'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function buildApp(health: RuntimeHealth, slowMs = 20) {
	const app = new Hono()
	app.use('/api/*', requestTiming(health, { slowMs }))
	app.get('/api/fast', (c) => c.json({ ok: true }))
	app.get('/api/slow', async (c) => {
		await sleep(45)
		return c.json({ ok: true })
	})
	app.get('/api/sessions/:id', async (c) => {
		await sleep(45)
		return c.json({ id: c.req.param('id') })
	})
	app.get('/api/stream', async () => {
		await sleep(45)
		return new Response('data: hi\n\n', { headers: { 'content-type': 'text/event-stream' } })
	})
	app.get('/api/redirect', () => Response.redirect('http://localhost/api/fast', 302))
	app.get('/api/boom', () => {
		throw new Error('handler failed')
	})
	return app
}

describe('requestTiming', () => {
	let health: RuntimeHealth
	let warn: ReturnType<typeof vi.spyOn>
	let debug: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		health = new RuntimeHealth()
		warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('adds a Server-Timing header with handler time, loop lag and in-flight count', async () => {
		const res = await buildApp(health).request('/api/fast')

		const header = res.headers.get('Server-Timing') ?? ''
		expect(header).toMatch(/app;dur=\d+(\.\d+)?/)
		expect(header).toMatch(/loop-p99;desc="[^"]+";dur=\d+(\.\d+)?/)
		expect(header).toMatch(/in-flight;desc="[^"]+";dur=1\b/)
	})

	it('reports a handler time that reflects how long the handler took', async () => {
		const res = await buildApp(health).request('/api/slow')

		const dur = Number(/app;dur=(\d+(?:\.\d+)?)/.exec(res.headers.get('Server-Timing') ?? '')?.[1])
		expect(dur).toBeGreaterThanOrEqual(40)
	})

	it('does not log a fast request', async () => {
		await buildApp(health).request('/api/fast')

		expect(warn).not.toHaveBeenCalled()
	})

	it('logs a slow request with its normalized route, never the raw id', async () => {
		await buildApp(health).request(`/api/sessions/${SESSION_ID}`)

		expect(warn).toHaveBeenCalledTimes(1)
		const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>]
		expect(message).toBe('Slow request')
		expect(context).toMatchObject({ method: 'GET', route: '/api/sessions/:id', status: 200 })
		expect(Number(context.duration_ms)).toBeGreaterThanOrEqual(40)
		expect(JSON.stringify(context)).not.toContain(SESSION_ID)
	})

	it('leaves streaming responses out: no header, no slow log, not counted', async () => {
		const res = await buildApp(health).request('/api/stream')

		expect(res.headers.get('Server-Timing')).toBeNull()
		expect(warn).not.toHaveBeenCalled()
		health.report()
		expect(debug).toHaveBeenCalledWith('runtime_health', expect.objectContaining({ requests: 0 }))
	})

	it('does not fail a response whose headers are immutable', async () => {
		const res = await buildApp(health).request('/api/redirect')

		expect(res.status).toBe(302)
	})

	it('still times and returns the error response when a handler throws', async () => {
		const res = await buildApp(health).request('/api/boom')

		expect(res.status).toBe(500)
		expect(res.headers.get('Server-Timing')).toContain('app;dur=')
	})

	it('returns the in-flight count to zero and remembers the concurrent peak', async () => {
		const app = buildApp(health)

		await Promise.all([
			app.request('/api/slow'),
			app.request('/api/slow'),
			app.request('/api/slow'),
		])

		expect(health.inFlightNow).toBe(0)
		health.report()
		expect(debug).toHaveBeenCalledWith(
			'runtime_health',
			expect.objectContaining({ in_flight_peak: 3, requests: 3 }),
		)
	})

	it('caps slow-request log lines per minute', async () => {
		const app = buildApp(health, 0)

		for (let i = 0; i < 40; i++) await app.request('/api/fast')

		const slowLogs = warn.mock.calls.filter(([message]) => message === 'Slow request')
		expect(slowLogs).toHaveLength(30)
	})
})

describe('normalizeRoutePath', () => {
	it('replaces uuids and long numeric segments', () => {
		expect(normalizeRoutePath(`/api/sessions/${SESSION_ID}/logs`)).toBe('/api/sessions/:id/logs')
		expect(normalizeRoutePath('/api/conversations/x/messages/13199/retry')).toBe(
			'/api/conversations/x/messages/:n/retry',
		)
	})

	it('keeps short numeric segments and plain paths', () => {
		expect(normalizeRoutePath('/api/v3/objects')).toBe('/api/v3/objects')
	})

	it('truncates very long paths', () => {
		expect(normalizeRoutePath(`/${'a'.repeat(500)}`).length).toBe(120)
	})
})
