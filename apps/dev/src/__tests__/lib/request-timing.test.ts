import { timeQueries } from '@maskin/db'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const info = vi.hoisted(() => vi.fn())
vi.mock('../../lib/logger', () => ({
	logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { flushRouteTiming, recordDbTime, requestTiming } from '../../lib/request-timing'

// A stand-in for a postgres.js query: lazy, and only "runs" when awaited.
function fakeQuery(ms: number, fail = false) {
	return {
		// biome-ignore lint/suspicious/noThenProperty: mimics the lazy thenable postgres.js returns
		then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
			const run = new Promise((resolve, reject) =>
				setTimeout(() => (fail ? reject(new Error('boom')) : resolve([])), ms),
			)
			return run.then(onFulfilled, onRejected)
		},
	}
}

function fakeClient() {
	const client = {
		options: { parsers: {} },
		unsafe: () => fakeQuery(20),
		begin: async (fn: (tx: unknown) => unknown) => fn({ unsafe: () => fakeQuery(20) }),
	}
	return client
}

function linesFor(msg: string) {
	return info.mock.calls.filter((c) => c[0] === msg).map((c) => c[1] as Record<string, unknown>)
}

describe('timeQueries', () => {
	it('reports the time of a query once it is awaited', async () => {
		const timer = vi.fn()
		const client = timeQueries(fakeClient(), timer)
		await client.unsafe()
		expect(timer).toHaveBeenCalledTimes(1)
		expect(timer.mock.calls[0][0]).toBeGreaterThanOrEqual(15)
	})

	it('reports a failed query and keeps the error', async () => {
		const timer = vi.fn()
		const client = timeQueries({ unsafe: () => fakeQuery(5, true) }, timer)
		await expect(client.unsafe()).rejects.toThrow('boom')
		expect(timer).toHaveBeenCalledTimes(1)
	})

	it('reports queries run inside a transaction and passes other properties through', async () => {
		const timer = vi.fn()
		const raw = fakeClient()
		const client = timeQueries(raw, timer)
		await client.begin(async (tx) => {
			await (tx as ReturnType<typeof fakeClient>).unsafe()
		})
		expect(timer).toHaveBeenCalledTimes(1)
		expect(client.options).toBe(raw.options)
	})
})

describe('requestTiming', () => {
	beforeEach(() => {
		flushRouteTiming()
		info.mockClear()
	})

	function buildApp() {
		const app = new Hono()
		app.use('/api/*', requestTiming())
		app.get('/api/health', (c) => c.json({ ok: true }))
		app.get('/api/objects/:id', async (c) => {
			await timeQueries({ unsafe: () => fakeQuery(30) }, recordDbTime).unsafe()
			await timeQueries({ unsafe: () => fakeQuery(30) }, recordDbTime).unsafe()
			return c.json({ id: c.req.param('id') })
		})
		app.get('/api/events', (c) =>
			streamSSE(c, async (stream) => {
				await timeQueries({ unsafe: () => fakeQuery(30) }, recordDbTime).unsafe()
				await stream.writeSSE({ data: 'x' })
			}),
		)
		return app
	}

	it('logs the route pattern with summed database time, never the raw URL', async () => {
		const res = await buildApp().request('/api/objects/6f1c-secret-id?token=abc')
		expect(res.status).toBe(200)

		flushRouteTiming()
		const [line] = linesFor('api_route_timing')
		expect(line.route).toBe('/api/objects/:id')
		expect(line.method).toBe('GET')
		expect(line.stream).toBe(false)
		expect(line.requests).toBe(1)
		expect(line.db_queries).toBe(2)
		expect(line.db_ms_sum as number).toBeGreaterThanOrEqual(50)
		expect(line.total_ms_sum as number).toBeGreaterThanOrEqual(line.db_ms_sum as number)
		expect(JSON.stringify(info.mock.calls)).not.toContain('secret-id')
	})

	it('adds a separate line for a request slow in the database', async () => {
		const app = new Hono()
		app.use('/api/*', requestTiming())
		app.get('/api/slow', (c) => {
			recordDbTime(900)
			return c.text('ok')
		})
		await app.request('/api/slow')

		const [slow] = linesFor('api_slow_request')
		expect(slow.route).toBe('/api/slow')
		expect(slow.db_ms).toBe(900)
	})

	it('does not time the health check', async () => {
		await buildApp().request('/api/health')
		flushRouteTiming()
		expect(linesFor('api_route_timing')).toHaveLength(0)
	})

	it('records an event stream separately when the client disconnects', async () => {
		const controller = new AbortController()
		const res = await buildApp().request(
			new Request('http://localhost/api/events', { signal: controller.signal }),
		)
		await res.text().catch(() => {})
		flushRouteTiming()
		expect(linesFor('api_route_timing')).toHaveLength(0)

		controller.abort()
		flushRouteTiming()
		const [line] = linesFor('api_route_timing')
		expect(line.route).toBe('/api/events')
		expect(line.stream).toBe(true)
		expect(line.db_queries).toBe(1)
	})
})
