import { type Server, type Socket, createServer } from 'node:net'
import {
	DATABASE_BUSY_QUERIES,
	QueryTimeoutError,
	countRunningQueries,
	countStalledQueries,
	createDb,
	createInFlight,
	describeInFlight,
	timeQueries,
} from '@maskin/db'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A stand-in for a postgres.js query: lazy, and only "runs" when awaited.
function fakeQuery(ms: number) {
	return {
		cancelled: false,
		cancel() {
			this.cancelled = true
		},
		// biome-ignore lint/suspicious/noThenProperty: mimics the lazy thenable postgres.js returns
		then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
			return new Promise((resolve) => setTimeout(() => resolve(['ok']), ms)).then(
				onFulfilled,
				onRejected,
			)
		},
	}
}

describe('timeQueries deadline', () => {
	it('rejects with QueryTimeoutError and cancels when the server never answers', async () => {
		const query = fakeQuery(5_000)
		const client = timeQueries({ unsafe: () => query }, undefined, { queryTimeoutMs: 30 })
		await expect(client.unsafe()).rejects.toBeInstanceOf(QueryTimeoutError)
		expect(query.cancelled).toBe(true)
	})

	it('still reports the duration of a query that timed out', async () => {
		const durations: number[] = []
		const client = timeQueries({ unsafe: () => fakeQuery(5_000) }, (ms) => durations.push(ms), {
			queryTimeoutMs: 30,
		})
		await expect(client.unsafe()).rejects.toThrow('no response within 30ms')
		expect(durations).toHaveLength(1)
	})

	it('returns the result of a query that finishes in time', async () => {
		const client = timeQueries({ unsafe: () => fakeQuery(5) }, undefined, { queryTimeoutMs: 500 })
		await expect(client.unsafe()).resolves.toEqual(['ok'])
	})

	it('applies the deadline to queries inside a transaction', async () => {
		const client = timeQueries(
			{
				begin: async (fn: (tx: unknown) => unknown) => fn({ unsafe: () => fakeQuery(5_000) }),
			},
			undefined,
			{ queryTimeoutMs: 30 },
		)
		await expect(
			client.begin(async (tx) => (tx as { unsafe: () => PromiseLike<unknown> }).unsafe()),
		).rejects.toBeInstanceOf(QueryTimeoutError)
	})
})

describe('timeQueries pool diagnostics', () => {
	it('reports the in-flight count and a short SQL preview when a query times out', async () => {
		const seen: { timeoutMs: number; inFlight: number; sql: string }[] = []
		const client = timeQueries({ unsafe: (_text: string) => fakeQuery(5_000) }, undefined, {
			queryTimeoutMs: 30,
			onQueryTimeout: (info) => seen.push(info),
		})
		const longSql = `select ${'x'.repeat(200)}`
		const results = await Promise.allSettled([client.unsafe(longSql), client.unsafe('select 1')])
		expect(results.every((r) => r.status === 'rejected')).toBe(true)
		expect(seen).toHaveLength(2)
		expect(seen[0]).toMatchObject({ timeoutMs: 30, inFlight: 2 })
		expect(seen[0]?.sql).toHaveLength(80)
		expect(seen[1]?.sql).toBe('select 1')
	})

	it('calls onSaturated when the in-flight count reaches saturationAt', async () => {
		const saturated: number[] = []
		const client = timeQueries({ unsafe: () => fakeQuery(20) }, undefined, {
			saturationAt: 3,
			onSaturated: (n) => saturated.push(n),
		})
		await Promise.all([client.unsafe(), client.unsafe()])
		expect(saturated).toEqual([])
		await Promise.all([client.unsafe(), client.unsafe(), client.unsafe()])
		expect(saturated).toEqual([3])
	})

	it('counts queries inside a transaction with the rest of the client', async () => {
		const saturated: number[] = []
		const client = timeQueries(
			{
				unsafe: () => fakeQuery(30),
				begin: async (fn: (tx: unknown) => unknown) => fn({ unsafe: () => fakeQuery(30) }),
			},
			undefined,
			{ saturationAt: 2, onSaturated: (n) => saturated.push(n) },
		)
		await Promise.all([
			client.unsafe(),
			client.begin(async (tx) => (tx as { unsafe: () => PromiseLike<unknown> }).unsafe()),
		])
		expect(saturated).toEqual([2])
	})

	it('stops counting a query once it has finished or timed out', async () => {
		const saturated: number[] = []
		const client = timeQueries({ unsafe: () => fakeQuery(5) }, undefined, {
			saturationAt: 2,
			onSaturated: (n) => saturated.push(n),
		})
		for (let i = 0; i < 5; i++) await client.unsafe()
		expect(saturated).toEqual([])
	})
})

describe('timeQueries queued-query deadline', () => {
	it('gives a query sent into a full pool the shorter deadline', async () => {
		const client = timeQueries({ unsafe: () => fakeQuery(5_000) }, undefined, {
			queryTimeoutMs: 5_000,
			queuedQueryTimeoutMs: 30,
			saturationAt: 2,
		})
		// A query is only sent and counted once something awaits it, so start the two that fill the pool.
		const first = client.unsafe('select 1')
		const second = client.unsafe('select 2')
		void first.then(undefined, () => {})
		void second.then(undefined, () => {})
		const third = client.unsafe('select 3')
		await expect(third).rejects.toBeInstanceOf(QueryTimeoutError)
		// The two that fit in the pool keep the full deadline and are still waiting.
		const raced = await Promise.race([first, second, Promise.resolve('pending')])
		expect(raced).toBe('pending')
	})

	it('never raises a deadline above the one for the pool as a whole', async () => {
		const client = timeQueries({ unsafe: () => fakeQuery(5_000) }, undefined, {
			queryTimeoutMs: 30,
			queuedQueryTimeoutMs: 5_000,
			saturationAt: 1,
		})
		void client.unsafe('select 1').then(undefined, () => {})
		await expect(client.unsafe('select 2')).rejects.toBeInstanceOf(QueryTimeoutError)
	})
})

describe('describeInFlight', () => {
	it('groups unanswered queries by SQL, most common first, with the oldest wait', async () => {
		const inFlight = createInFlight()
		const client = timeQueries({ unsafe: () => fakeQuery(5_000) }, undefined, { inFlight })
		for (const text of ['select a', 'select b', 'select a']) {
			void client.unsafe(text).then(undefined, () => {})
		}
		const described = describeInFlight(inFlight)
		expect(described.map((d) => [d.sql, d.count])).toEqual([
			['select a', 2],
			['select b', 1],
		])
		expect(described[0]?.oldestMs).toBeGreaterThanOrEqual(0)
	})
})

describe('timeQueries waiting-time tracking', () => {
	it('counts a query once however many times it is awaited, caught or finally-ed', async () => {
		const load = createInFlight()
		const client = timeQueries({ unsafe: () => fakeQuery(10) }, undefined, { inFlight: load })
		const query = client.unsafe()
		await query
		await query
		await Promise.resolve(query).catch(() => {})
		await Promise.resolve(query).finally(() => {})
		expect(load.count).toBe(0)
		expect(load.pending.size).toBe(0)
	})

	it('does not count a query again when something awaits it after it finished', async () => {
		const load = createInFlight()
		const client = timeQueries({ unsafe: () => fakeQuery(5) }, undefined, { inFlight: load })
		const query = client.unsafe()
		await query
		for (let i = 0; i < 5; i++) await query
		expect(load.count).toBe(0)
	})

	it('returns to zero after queries that fail or time out', async () => {
		const load = createInFlight()
		const client = timeQueries({ unsafe: () => fakeQuery(5_000) }, undefined, {
			inFlight: load,
			queryTimeoutMs: 20,
		})
		await Promise.allSettled([client.unsafe(), client.unsafe()])
		expect(load.count).toBe(0)
		expect(load.pending.size).toBe(0)
	})

	it('counts only the queries that have waited longer than the limit', async () => {
		const load = createInFlight()
		const client = timeQueries({ unsafe: () => fakeQuery(300) }, undefined, { inFlight: load })
		const first = client.unsafe()
		const firstDone = Promise.resolve(first).then(() => {})
		await new Promise((r) => setTimeout(r, 150))
		const second = client.unsafe()
		const secondDone = Promise.resolve(second).then(() => {})
		await Promise.resolve()
		expect(countStalledQueries(load, 100, 10)).toBe(1)
		expect(countStalledQueries(load, 0, 10)).toBe(2)
		expect(countStalledQueries(load, 0, 1)).toBe(1)
		await Promise.all([firstDone, secondDone])
		expect(countStalledQueries(load, 0, 10)).toBe(0)
	})
})

describe('createDb against a peer that accepts the connection and never replies', () => {
	let server: Server | undefined
	const sockets: Socket[] = []

	afterEach(async () => {
		for (const s of sockets.splice(0)) s.destroy()
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
		server = undefined
	})

	it('fails fast instead of hanging', async () => {
		server = createServer((socket) => sockets.push(socket))
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
		const { port } = server.address() as { port: number }

		const db = createDb(`postgres://u:p@127.0.0.1:${port}/db`, { queryTimeoutMs: 200 })
		const started = Date.now()
		// drizzle wraps driver errors and keeps the original as `cause`
		const err = await db.execute(sql`select 1`).catch((e: unknown) => e)
		expect((err as Error).cause).toBeInstanceOf(QueryTimeoutError)
		expect(Date.now() - started).toBeLessThan(5_000)
	})
})

describe('createDb replaces the pool when a query is lost', () => {
	let server: Server | undefined
	const sockets: Socket[] = []

	afterEach(async () => {
		for (const s of sockets.splice(0)) s.destroy()
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
		server = undefined
	})

	async function silentPeer() {
		server = createServer((socket) => sockets.push(socket))
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
		return (server.address() as { port: number }).port
	}

	const idleDatabase = async () => [
		{
			state: 'idle',
			wait_event_type: 'Client',
			wait_event: 'ClientRead',
			connections: 20,
			longest_in_state_s: 5,
		},
	]
	const busyDatabase = async () => [
		{
			state: 'active',
			wait_event_type: null,
			wait_event: null,
			connections: DATABASE_BUSY_QUERIES,
			longest_in_state_s: 1,
		},
	]

	it('opens fresh connections after a query gets no answer and the database is idle', async () => {
		const port = await silentPeer()
		const recycled = vi.fn()
		const db = createDb(`postgres://u:p@127.0.0.1:${port}/db`, {
			queryTimeoutMs: 100,
			probe: idleDatabase,
			onPoolRecycled: recycled,
			recycleMinIntervalMs: 0,
		})
		await db.execute(sql`select 1`).catch(() => {})
		await vi.waitFor(() => expect(recycled).toHaveBeenCalledTimes(1))
		expect(recycled.mock.calls[0]?.[0]).toMatchObject({ runningQueries: 0 })

		const before = sockets.length
		await db.execute(sql`select 1`).catch(() => {})
		expect(sockets.length).toBeGreaterThan(before)
	})

	it('keeps the pool when the database is busy running queries', async () => {
		const port = await silentPeer()
		const recycled = vi.fn()
		const db = createDb(`postgres://u:p@127.0.0.1:${port}/db`, {
			queryTimeoutMs: 100,
			probe: busyDatabase,
			onPoolRecycled: recycled,
			recycleMinIntervalMs: 0,
		})
		await db.execute(sql`select 1`).catch(() => {})
		await new Promise((r) => setTimeout(r, 150))
		expect(recycled).not.toHaveBeenCalled()
	})

	it('replaces the pool when the database cannot be asked either', async () => {
		const port = await silentPeer()
		const recycled = vi.fn()
		const db = createDb(`postgres://u:p@127.0.0.1:${port}/db`, {
			queryTimeoutMs: 100,
			probe: async () => {
				throw new Error('no answer')
			},
			onPoolRecycled: recycled,
			recycleMinIntervalMs: 0,
		})
		await db.execute(sql`select 1`).catch(() => {})
		await vi.waitFor(() => expect(recycled).toHaveBeenCalledTimes(1))
		expect(recycled.mock.calls[0]?.[0]).toMatchObject({ runningQueries: null })
	})

	it('replaces the pool at most once per interval however many queries time out', async () => {
		const port = await silentPeer()
		const recycled = vi.fn()
		const db = createDb(`postgres://u:p@127.0.0.1:${port}/db`, {
			queryTimeoutMs: 100,
			probe: idleDatabase,
			onPoolRecycled: recycled,
			recycleMinIntervalMs: 60_000,
		})
		await Promise.allSettled([1, 2, 3, 4].map(() => db.execute(sql`select 1`)))
		await vi.waitFor(() => expect(recycled).toHaveBeenCalledTimes(1))
		await new Promise((r) => setTimeout(r, 100))
		expect(recycled).toHaveBeenCalledTimes(1)
	})
})

describe('countRunningQueries', () => {
	it('counts only backends that are running a query, not ones waiting on the client', () => {
		expect(
			countRunningQueries([
				{
					state: 'idle',
					wait_event_type: 'Client',
					wait_event: 'ClientRead',
					connections: 20,
					longest_in_state_s: 9,
				},
				{
					state: 'active',
					wait_event_type: 'Client',
					wait_event: 'ClientRead',
					connections: 7,
					longest_in_state_s: 0,
				},
				{
					state: 'active',
					wait_event_type: null,
					wait_event: null,
					connections: 3,
					longest_in_state_s: 0,
				},
				{
					state: 'active',
					wait_event_type: 'IO',
					wait_event: 'DataFileRead',
					connections: 2,
					longest_in_state_s: 0,
				},
			]),
		).toBe(5)
	})
})
