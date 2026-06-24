import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type DispatchFn,
	type DispatchResult,
	SessionDispatchQueue,
	dispatchIdempotencyKey,
} from '../../services/session-dispatch-queue'

type DispatchRow = {
	id: string
	sessionId: string
	idempotencyKey: string
	attempt: number
	maxAttempts: number
	status: 'pending' | 'failed'
	nextAttemptAt: Date
	lastError: string | null
	createdAt: Date
	updatedAt: Date
}

type SessionRow = {
	id: string
	workspaceId: string
	actorId: string
	status: string
	result: unknown
	completedAt: Date | null
	updatedAt: Date
}

type EventRow = {
	workspaceId: string
	actorId: string
	action: string
	entityType: string
	entityId: string
	data: unknown
}

/**
 * Hand-rolled fake of just the drizzle methods the queue calls. Stores rows in
 * memory; transactions reuse the same store (no isolation) — sufficient for
 * single-process queue behavior tests.
 */
function makeFakeDb(
	opts: {
		dispatchRows?: DispatchRow[]
		sessionRows?: SessionRow[]
	} = {},
) {
	const dispatchRows: DispatchRow[] = [...(opts.dispatchRows ?? [])]
	const sessionRows: SessionRow[] = [...(opts.sessionRows ?? [])]
	const events: EventRow[] = []
	let nextId = 1
	const newId = () => `row-${nextId++}`

	const matchTable = (table: unknown) => {
		const name = (table as { _?: { name?: string } } | undefined)?._?.name
		return name ?? ''
	}

	const buildApi = () => {
		const api = {
			insert(table: unknown) {
				const name = matchTable(table)
				return {
					values(value: Partial<DispatchRow> | EventRow) {
						if (name === 'events') {
							events.push(value as EventRow)
							return Promise.resolve()
						}
						return {
							onConflictDoNothing() {
								if (name === 'session_dispatch_attempts') {
									const v = value as Partial<DispatchRow>
									const existing = dispatchRows.find((r) => r.sessionId === v.sessionId)
									if (!existing) {
										dispatchRows.push({
											id: newId(),
											sessionId: v.sessionId ?? '',
											idempotencyKey: v.idempotencyKey ?? '',
											attempt: 0,
											maxAttempts: v.maxAttempts ?? 5,
											status: 'pending',
											nextAttemptAt: v.nextAttemptAt ?? new Date(),
											lastError: null,
											createdAt: new Date(),
											updatedAt: new Date(),
										})
									}
								}
								return Promise.resolve()
							},
						}
					},
				}
			},
			select(_columns?: unknown) {
				return {
					from(table: unknown) {
						const name = matchTable(table)
						const ctx: {
							rows: (DispatchRow | SessionRow)[]
							sorted: boolean
							predicate: ((r: DispatchRow | SessionRow) => boolean) | null
						} = {
							rows:
								name === 'session_dispatch_attempts'
									? dispatchRows.slice()
									: name === 'sessions'
										? sessionRows.slice()
										: [],
							sorted: false,
							predicate: null,
						}
						const chain = {
							where(predicate: { __pred: (r: DispatchRow | SessionRow) => boolean }) {
								ctx.predicate = predicate.__pred
								return chain
							},
							orderBy(_o: unknown) {
								ctx.sorted = true
								return chain
							},
							limit(n: number) {
								let out = ctx.predicate ? ctx.rows.filter(ctx.predicate) : ctx.rows
								if (ctx.sorted && name === 'session_dispatch_attempts') {
									out = (out as DispatchRow[])
										.slice()
										.sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
								}
								const limited = out.slice(0, n)
								const promise: Promise<unknown> & {
									for: (_lock: string, _opts?: { skipLocked?: boolean }) => Promise<unknown>
								} = Object.assign(Promise.resolve(limited), {
									for: (_lock: string, _opts?: { skipLocked?: boolean }) =>
										Promise.resolve(limited),
								})
								return promise
							},
						}
						return chain
					},
				}
			},
			update(table: unknown) {
				const name = matchTable(table)
				return {
					set(values: Partial<DispatchRow & SessionRow>) {
						const chain = {
							where(predicate: { __pred: (r: DispatchRow | SessionRow) => boolean }) {
								const arr =
									name === 'session_dispatch_attempts'
										? dispatchRows
										: name === 'sessions'
											? sessionRows
											: []
								const matches: (DispatchRow | SessionRow)[] = []
								for (const r of arr) {
									if (predicate.__pred(r)) {
										Object.assign(r, values)
										matches.push(r)
									}
								}
								const returningPromise: Promise<unknown> & {
									returning: (_columns?: unknown) => Promise<unknown>
								} = Object.assign(Promise.resolve(matches), {
									returning: (_columns?: unknown) => Promise.resolve(matches),
								})
								return returningPromise
							},
						}
						return chain
					},
				}
			},
			delete(table: unknown) {
				const name = matchTable(table)
				return {
					where(predicate: { __pred: (r: DispatchRow | SessionRow) => boolean }) {
						if (name === 'session_dispatch_attempts') {
							for (let i = dispatchRows.length - 1; i >= 0; i--) {
								const row = dispatchRows[i]
								if (row && predicate.__pred(row)) dispatchRows.splice(i, 1)
							}
						}
						return Promise.resolve()
					},
				}
			},
			transaction<T>(cb: (tx: typeof api) => Promise<T>): Promise<T> {
				return cb(api)
			},
		}
		return api
	}

	const api = buildApi()
	return { db: api, dispatchRows, sessionRows, events }
}

/**
 * Replace drizzle's opaque predicate types with a `__pred` function the fake
 * DB can evaluate against rows in memory. Real drizzle ignores the body — only
 * the fake reads `__pred`.
 */
vi.mock('drizzle-orm', async () => {
	const eq = (col: { __name: string }, v: unknown) => ({
		__pred: (r: Record<string, unknown>) => r[col.__name] === v,
	})
	const and = (...preds: { __pred: (r: Record<string, unknown>) => boolean }[]) => ({
		__pred: (r: Record<string, unknown>) => preds.every((p) => p.__pred(r)),
	})
	const lte = (col: { __name: string }, v: Date) => ({
		__pred: (r: Record<string, unknown>) =>
			(r[col.__name] as Date | undefined)?.getTime?.() !== undefined &&
			(r[col.__name] as Date).getTime() <= v.getTime(),
	})
	const asc = (_col: unknown) => ({})
	const sql = (..._args: unknown[]) => ({ __pred: () => true })
	return { eq, and, lte, asc, sql }
})

/**
 * Replace `@maskin/db/schema` with stub column objects whose `__name` matches
 * the fake DB's row property names, plus a `_.name` on each table the fake
 * uses to route operations.
 */
vi.mock('@maskin/db/schema', () => {
	const col = (name: string) => ({ __name: name })
	return {
		sessionDispatchAttempts: {
			_: { name: 'session_dispatch_attempts' },
			id: col('id'),
			sessionId: col('sessionId'),
			idempotencyKey: col('idempotencyKey'),
			attempt: col('attempt'),
			maxAttempts: col('maxAttempts'),
			status: col('status'),
			nextAttemptAt: col('nextAttemptAt'),
			lastError: col('lastError'),
		},
		sessions: {
			_: { name: 'sessions' },
			id: col('id'),
			status: col('status'),
		},
		events: {
			_: { name: 'events' },
		},
	}
})

function makeQueue(db: unknown, dispatchFn: DispatchFn, opts = {}) {
	return new SessionDispatchQueue(db as never, dispatchFn, {
		tickMs: 1_000_000,
		baseBackoffMs: 1_000,
		maxBackoffMs: 60_000,
		noCapacityBackoffMs: 5_000,
		maxAttempts: 3,
		batchSize: 5,
		leaseMs: 30_000,
		...opts,
	})
}

function aDispatchRow(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'd-1',
		sessionId: 's-1',
		idempotencyKey: dispatchIdempotencyKey('s-1'),
		attempt: 0,
		maxAttempts: 3,
		status: 'pending',
		nextAttemptAt: new Date('2026-06-12T08:00:00Z'),
		lastError: null,
		createdAt: new Date('2026-06-12T07:59:00Z'),
		updatedAt: new Date('2026-06-12T07:59:00Z'),
		...overrides,
	}
}

function aSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: 's-1',
		workspaceId: 'ws-1',
		actorId: 'a-1',
		status: 'pending',
		result: null,
		completedAt: null,
		updatedAt: new Date('2026-06-12T07:59:00Z'),
		...overrides,
	}
}

describe('dispatchIdempotencyKey', () => {
	it('is stable for the same session', () => {
		const a = dispatchIdempotencyKey('session-abc')
		const b = dispatchIdempotencyKey('session-abc')
		expect(a).toBe(b)
		expect(a).toBe('dispatch:session-abc')
	})

	it('differs across sessions', () => {
		expect(dispatchIdempotencyKey('a')).not.toBe(dispatchIdempotencyKey('b'))
	})
})

describe('SessionDispatchQueue.enqueue', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-06-12T08:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('inserts a row for a new session', async () => {
		const { db, dispatchRows } = makeFakeDb()
		const queue = makeQueue(db, async () => ({ kind: 'dispatched' }))

		const row = await queue.enqueue('session-new')

		expect(dispatchRows).toHaveLength(1)
		expect(row.sessionId).toBe('session-new')
		expect(row.idempotencyKey).toBe('dispatch:session-new')
		expect(row.attempt).toBe(0)
		expect(row.status).toBe('pending')
	})

	it('is a no-op when the session is already enqueued', async () => {
		const existing = aDispatchRow({ sessionId: 's-x', attempt: 2 })
		const { db, dispatchRows } = makeFakeDb({ dispatchRows: [existing] })
		const queue = makeQueue(db, async () => ({ kind: 'dispatched' }))

		const row = await queue.enqueue('s-x')

		expect(dispatchRows).toHaveLength(1)
		expect(row.attempt).toBe(2) // existing row left as-is
	})
})

describe('SessionDispatchQueue.tick — outcomes', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-06-12T08:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('deletes the row on dispatched', async () => {
		const row = aDispatchRow()
		const { db, dispatchRows } = makeFakeDb({ dispatchRows: [row] })
		const dispatchFn = vi.fn(async () => ({ kind: 'dispatched' }) satisfies DispatchResult)
		const queue = makeQueue(db, dispatchFn)

		await queue.tick()

		expect(dispatchFn).toHaveBeenCalledWith('s-1', 'dispatch:s-1')
		expect(dispatchRows).toHaveLength(0)
	})

	it('parks the row on no_capacity without consuming an attempt', async () => {
		const row = aDispatchRow({ attempt: 1 })
		const { db, dispatchRows } = makeFakeDb({ dispatchRows: [row] })
		const queue = makeQueue(db, async () => ({ kind: 'no_capacity' }), {
			noCapacityBackoffMs: 5_000,
		})

		await queue.tick()

		expect(dispatchRows).toHaveLength(1)
		const updated = dispatchRows[0]
		if (!updated) throw new Error('row missing')
		expect(updated.attempt).toBe(1) // unchanged
		expect(updated.status).toBe('pending')
		// Default base backoff is 1000ms — no_capacity uses noCapacityBackoffMs (5000ms).
		// Lease pushes the row to now+leaseMs first, then handleNoCapacity overwrites
		// to now+noCapacityBackoffMs. The latter is what we assert.
		expect(updated.nextAttemptAt.getTime()).toBe(Date.now() + 5_000)
	})

	it('schedules an exponential-backoff retry on transient_failure', async () => {
		const row = aDispatchRow({ attempt: 0 })
		const { db, dispatchRows } = makeFakeDb({ dispatchRows: [row] })
		const queue = makeQueue(
			db,
			async () => ({ kind: 'transient_failure', error: 'connection refused' }),
			{ baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
		)

		await queue.tick()
		const after1 = dispatchRows[0]
		if (!after1) throw new Error('row missing')
		expect(after1.attempt).toBe(1)
		expect(after1.status).toBe('pending')
		expect(after1.lastError).toBe('connection refused')
		// attempt 1 → 1000ms backoff
		expect(after1.nextAttemptAt.getTime()).toBe(Date.now() + 1_000)
	})

	it('exhausting maxAttempts marks the row and the session failed', async () => {
		const row = aDispatchRow({ attempt: 2, maxAttempts: 3 })
		const session = aSessionRow()
		const { db, dispatchRows, sessionRows, events } = makeFakeDb({
			dispatchRows: [row],
			sessionRows: [session],
		})
		const queue = makeQueue(db, async () => ({
			kind: 'transient_failure',
			error: 'still failing',
		}))

		await queue.tick()

		const finalRow = dispatchRows[0]
		if (!finalRow) throw new Error('row missing')
		expect(finalRow.status).toBe('failed')
		expect(finalRow.attempt).toBe(3)
		expect(finalRow.lastError).toBe('still failing')

		const finalSession = sessionRows[0]
		if (!finalSession) throw new Error('session missing')
		expect(finalSession.status).toBe('failed')
		const result = finalSession.result as { error: string }
		expect(result.error).toContain('Dispatch exhausted after 3 attempts')
		expect(result.error).toContain('still failing')

		expect(events).toHaveLength(1)
		expect(events[0]?.action).toBe('session_failed')
		expect((events[0]?.data as { source: string }).source).toBe('dispatch_queue')
	})

	it('marks the row failed immediately on permanent_failure', async () => {
		const row = aDispatchRow({ attempt: 0, maxAttempts: 10 })
		const session = aSessionRow()
		const { db, dispatchRows, sessionRows } = makeFakeDb({
			dispatchRows: [row],
			sessionRows: [session],
		})
		const queue = makeQueue(db, async () => ({
			kind: 'permanent_failure',
			error: 'unknown session id',
		}))

		await queue.tick()

		const finalRow = dispatchRows[0]
		if (!finalRow) throw new Error('row missing')
		expect(finalRow.status).toBe('failed')
		const finalSession = sessionRows[0]
		if (!finalSession) throw new Error('session missing')
		expect(finalSession.status).toBe('failed')
	})

	it('treats thrown errors as transient_failure', async () => {
		const row = aDispatchRow({ attempt: 0, maxAttempts: 5 })
		const { db, dispatchRows } = makeFakeDb({ dispatchRows: [row] })
		const queue = makeQueue(db, async () => {
			throw new Error('dispatcher crashed')
		})

		await queue.tick()

		const updated = dispatchRows[0]
		if (!updated) throw new Error('row missing')
		expect(updated.attempt).toBe(1)
		expect(updated.status).toBe('pending')
		expect(updated.lastError).toBe('dispatcher crashed')
	})

	it('passes the same idempotency key on every retry of the same session', async () => {
		const row = aDispatchRow({ attempt: 0 })
		const { db } = makeFakeDb({ dispatchRows: [row] })
		const observedKeys: string[] = []
		const queue = makeQueue(db, async (sessionId, key) => {
			observedKeys.push(key)
			return { kind: 'transient_failure', error: 'still broken' }
		})

		// First attempt
		await queue.tick()
		// Advance time enough that the backoff has elapsed — fake DB stores
		// next_attempt_at directly so we rewrite it to "now".
		vi.setSystemTime(new Date(Date.now() + 60_000))
		await queue.tick()
		vi.setSystemTime(new Date(Date.now() + 60_000))
		await queue.tick()

		expect(observedKeys).toHaveLength(3)
		expect(observedKeys.every((k) => k === 'dispatch:s-1')).toBe(true)
	})

	it('skips rows whose next_attempt_at is in the future', async () => {
		const future = new Date(Date.now() + 60_000)
		const row = aDispatchRow({ nextAttemptAt: future })
		const { db } = makeFakeDb({ dispatchRows: [row] })
		const dispatchFn = vi.fn(async () => ({ kind: 'dispatched' }) satisfies DispatchResult)
		const queue = makeQueue(db, dispatchFn)

		await queue.tick()

		expect(dispatchFn).not.toHaveBeenCalled()
	})

	it('does not re-enter while a tick is in flight', async () => {
		vi.useRealTimers() // microtasks need to drain between the two ticks
		const row = aDispatchRow()
		const { db } = makeFakeDb({ dispatchRows: [row] })
		let release: (() => void) | null = null
		const dispatchFn = vi.fn(
			(): Promise<DispatchResult> =>
				new Promise((resolve) => {
					release = () => resolve({ kind: 'dispatched' })
				}),
		)
		const queue = makeQueue(db, dispatchFn)

		const first = queue.tick()
		// Let the first tick reach `await this.dispatchFn(...)` so the running
		// flag is set and dispatchFn has been invoked.
		await vi.waitFor(() => expect(dispatchFn).toHaveBeenCalledTimes(1))
		await queue.tick() // should bail because running=true
		expect(dispatchFn).toHaveBeenCalledTimes(1)

		release?.()
		await first
	})
})

describe('SessionDispatchQueue — exponential backoff caps', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-06-12T08:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('clamps the backoff at maxBackoffMs', async () => {
		const row = aDispatchRow({ maxAttempts: 20 })
		const { db, dispatchRows } = makeFakeDb({ dispatchRows: [row] })
		const queue = makeQueue(db, async () => ({ kind: 'transient_failure', error: 'e' }), {
			baseBackoffMs: 1_000,
			maxBackoffMs: 4_000,
			maxAttempts: 20,
		})

		// 6 attempts so the doubling exceeds the cap: 1s, 2s, 4s, 8s→4s, 16s→4s, 32s→4s.
		const deltas: number[] = []
		for (let i = 0; i < 6; i++) {
			const before = Date.now()
			await queue.tick()
			const current = dispatchRows[0]
			if (!current) throw new Error('row missing')
			deltas.push(current.nextAttemptAt.getTime() - before)
			vi.setSystemTime(new Date(before + 10_000))
		}

		expect(deltas).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000])
	})
})

describe('SessionDispatchQueue.setDispatchFn', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-06-12T08:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('swaps the dispatch callback used by subsequent ticks', async () => {
		const { db } = makeFakeDb({ dispatchRows: [aDispatchRow()] })
		const original = vi.fn(async () => ({ kind: 'no_capacity' }) satisfies DispatchResult)
		const swapped = vi.fn(async () => ({ kind: 'dispatched' }) satisfies DispatchResult)
		const queue = makeQueue(db, original)

		queue.setDispatchFn(swapped)
		await queue.tick()

		expect(swapped).toHaveBeenCalledTimes(1)
		expect(original).not.toHaveBeenCalled()
	})
})
