import { type Server, type Socket, createServer } from 'node:net'
import { QueryTimeoutError, createDb, timeQueries } from '@maskin/db'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'

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
