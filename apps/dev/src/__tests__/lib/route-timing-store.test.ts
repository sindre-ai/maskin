import { beforeEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}))

import {
	flushRouteTiming,
	parseClientBuild,
	requestTiming,
	setRouteTimingSink,
} from '../../lib/request-timing'
import { createRouteTimingStore, currentBuild } from '../../lib/route-timing-store'

function fakeDb(opts: { failInsert?: boolean; deleted?: number[] } = {}) {
	const values = vi.fn()
	const onConflictDoUpdate = vi.fn(async () => {
		if (opts.failInsert) throw new Error('relation does not exist')
	})
	const deletes = [...(opts.deleted ?? [])]
	const del = vi.fn(() => ({
		where: () => ({
			returning: async () => Array.from({ length: deletes.shift() ?? 0 }, () => ({ minute: 1 })),
		}),
	}))
	const db = {
		insert: () => ({
			values: (v: unknown) => {
				values(v)
				return { onConflictDoUpdate }
			},
		}),
		delete: del,
	}
	return { db: db as never, values, onConflictDoUpdate, del }
}

const row = {
	method: 'GET',
	route: '/api/objects/:id',
	stream: false,
	clientBuild: '',
	requests: 3,
	slowRequests: 1,
	errors5xx: 0,
	totalMs: 120.5,
	dbMs: 80,
	dbQueries: 6,
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createRouteTimingStore', () => {
	beforeEach(() => {
		warn.mockClear()
		setRouteTimingSink(undefined)
	})

	it('writes one row per route for the minute of the flush, counts only', async () => {
		const { db, values } = fakeDb()
		const sink = createRouteTimingStore(db, 'abc123')
		sink([row], new Date('2026-11-08T10:15:42.123Z'))
		await settle()
		expect(values).toHaveBeenCalledTimes(1)
		const [written] = values.mock.calls[0][0]
		expect(written).toEqual({
			minute: new Date('2026-11-08T10:15:00.000Z'),
			build: 'abc123',
			method: 'GET',
			route: '/api/objects/:id',
			stream: false,
			clientBuild: '',
			requests: 3,
			slowRequests: 1,
			errors5xx: 0,
			totalMsSum: 120.5,
			dbMsSum: 80,
			dbQueries: 6,
		})
	})

	it('writes the app build next to the server build', async () => {
		const { db, values } = fakeDb()
		createRouteTimingStore(db, 'abc123')([{ ...row, clientBuild: '2611081015' }])
		await settle()
		const [written] = values.mock.calls[0][0]
		expect(written).toMatchObject({ build: 'abc123', clientBuild: '2611081015' })
	})

	it('adds into an existing row when the same minute is written twice', async () => {
		const { db, onConflictDoUpdate } = fakeDb()
		createRouteTimingStore(db, 'abc123')([row], new Date('2026-11-08T10:15:42Z'))
		await settle()
		expect(onConflictDoUpdate).toHaveBeenCalledTimes(1)
		const arg = (onConflictDoUpdate.mock.calls[0] as unknown[])[0] as {
			target: unknown[]
			set: Record<string, unknown>
		}
		expect(arg.target).toHaveLength(6)
		expect(Object.keys(arg.set).sort()).toEqual(
			['dbMsSum', 'dbQueries', 'errors5xx', 'requests', 'slowRequests', 'totalMsSum'].sort(),
		)
	})

	it('logs a failed write and does not throw', async () => {
		const { db } = fakeDb({ failInsert: true })
		const sink = createRouteTimingStore(db, 'abc123')
		expect(() => sink([row])).not.toThrow()
		await settle()
		expect(warn).toHaveBeenCalledWith(
			'api_route_timing_store failed',
			expect.objectContaining({ error: 'relation does not exist', rows: 1 }),
		)
		// The next flush still writes.
		sink([row], new Date(Date.now() + 61_000))
		await settle()
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it('removes rows older than 30 days at most once an hour, in slices', async () => {
		const { db, del } = fakeDb({ deleted: [5000, 12] })
		const sink = createRouteTimingStore(db, 'abc123')
		const t0 = new Date('2026-11-08T10:00:00Z')
		sink([row], t0)
		await settle()
		expect(del).toHaveBeenCalledTimes(2)
		sink([row], new Date(t0.getTime() + 60_000))
		await settle()
		expect(del).toHaveBeenCalledTimes(2)
		sink([row], new Date(t0.getTime() + 61 * 60_000))
		await settle()
		expect(del).toHaveBeenCalledTimes(3)
	})

	it('writes nothing for an empty flush', async () => {
		const { db, values } = fakeDb()
		createRouteTimingStore(db, 'abc123')([])
		await settle()
		expect(values).not.toHaveBeenCalled()
	})
})

describe('currentBuild', () => {
	it('uses the commit the web bundle reports, then the deploy commit, then unknown', () => {
		expect(currentBuild({ VITE_MASKIN_COMMIT_SHA: 'aaa', SOURCE_COMMIT: 'bbb' } as never)).toBe(
			'aaa',
		)
		expect(currentBuild({ SOURCE_COMMIT: 'bbb' } as never)).toBe('bbb')
		expect(currentBuild({} as never)).toBe('unknown')
	})
})

describe('flushRouteTiming with a sink', () => {
	beforeEach(() => setRouteTimingSink(undefined))

	it('hands the flushed buckets, with the slow count, to the sink', async () => {
		const { Hono } = await import('hono')
		const app = new Hono()
		app.use('*', requestTiming())
		app.get('/api/objects/:id', (c) => c.json({}))
		app.get('/api/boom', (c) => c.text('x', 500))
		const sink = vi.fn()
		setRouteTimingSink(sink)
		await app.request('/api/objects/1')
		await app.request('/api/objects/2')
		await app.request('/api/boom')
		flushRouteTiming()
		expect(sink).toHaveBeenCalledTimes(1)
		const rows = sink.mock.calls[0][0] as Array<Record<string, unknown>>
		expect(rows.map((r) => [r.route, r.requests, r.errors5xx, r.slowRequests]).sort()).toEqual(
			[
				['/api/boom', 1, 1, 0],
				['/api/objects/:id', 2, 0, 0],
			].sort(),
		)
	})

	it('splits the counts per app build and counts a missing or bad header as none', async () => {
		const { Hono } = await import('hono')
		const app = new Hono()
		app.use('*', requestTiming())
		app.get('/api/objects/:id', (c) => c.json({}))
		const sink = vi.fn()
		setRouteTimingSink(sink)
		const get = (build?: string) =>
			app.request(
				'/api/objects/1',
				build === undefined ? {} : { headers: { 'X-Client-Build': build } },
			)
		await get('2611081015')
		await get('2611081015')
		await get('2611071200')
		await get()
		await get('1.2.3')
		await get('<script>alert(1)</script>')
		flushRouteTiming()
		const rows = sink.mock.calls[0][0] as Array<{ clientBuild: string; requests: number }>
		expect(
			rows
				.map((r) => [r.clientBuild, r.requests])
				.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		).toEqual([
			['', 3],
			['2611071200', 1],
			['2611081015', 2],
		])
	})

	it('a sink that throws does not break the flush', async () => {
		const { Hono } = await import('hono')
		const app = new Hono()
		app.use('*', requestTiming())
		app.get('/api/x', (c) => c.json({}))
		setRouteTimingSink(() => {
			throw new Error('nope')
		})
		await app.request('/api/x')
		expect(() => flushRouteTiming()).not.toThrow()
		// Buckets were cleared, so the next flush has nothing to send.
		const sink = vi.fn()
		setRouteTimingSink(sink)
		flushRouteTiming()
		expect(sink).not.toHaveBeenCalled()
	})
})

describe('parseClientBuild', () => {
	it('keeps 1 to 12 digits and nothing else', () => {
		expect(parseClientBuild('2611081015')).toBe('2611081015')
		expect(parseClientBuild('123456789012')).toBe('123456789012')
		expect(parseClientBuild('1')).toBe('1')
		expect(parseClientBuild('1234567890123')).toBe('')
		expect(parseClientBuild('')).toBe('')
		expect(parseClientBuild(undefined)).toBe('')
		expect(parseClientBuild(null)).toBe('')
		expect(parseClientBuild('12 34')).toBe('')
		expect(parseClientBuild('1234\n')).toBe('')
		expect(parseClientBuild('-1')).toBe('')
		expect(parseClientBuild('abc')).toBe('')
	})
})
