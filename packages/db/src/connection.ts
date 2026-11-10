import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { type ConnectionSnapshotRow, captureConnectionSnapshot } from './connection-snapshot'
import * as schema from './schema'

type QueryTimer = (ms: number) => void

/**
 * Longest a query may wait for its result. Above the role-level `statement_timeout` (20s on
 * Supabase) so a slow query still fails on the server first; this only fires when the server
 * never answers, e.g. a half-open connection stuck in `ClientRead`, which no server-side timer
 * covers because the query never arrived whole.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 45_000

/**
 * Deadline for a query sent while every pooled connection already has a query on it. It has to
 * wait its turn, so a stall in the pool shows as these failing in seconds instead of piling up
 * for the full 45s. Kept above the longest query we expect (object search, about 7s) and below
 * the server-side `statement_timeout`.
 */
export const DEFAULT_QUEUED_QUERY_TIMEOUT_MS = 15_000

export class QueryTimeoutError extends Error {
	constructor(ms: number) {
		super(`Database query got no response within ${ms}ms`)
		this.name = 'QueryTimeoutError'
	}
}

/** What a query that got no answer looks like from the caller's side. */
export type QueryTimeoutInfo = {
	timeoutMs: number
	/** Queries sent and not yet answered, this one included. At or above the pool size, the rest are queuing for a connection. */
	inFlight: number
	/** The first characters of the SQL text; never its parameters. */
	sql: string
}

/**
 * Queries sent and not yet answered, shared by a client and the transactions opened on it.
 * `pending` maps each unanswered query to when it was sent, oldest first, so how long queries
 * have really been waiting can be read off it. `count` is only for logging: a counter that is
 * bumped and dropped by separate calls can drift, and the incident logs showed it reading
 * 1,371 while the health check still answered in 25 ms.
 */
export type InFlight = {
	count: number
	pending: Map<object, number>
	/** The first characters of each unanswered query's SQL, so a full pool can say what is in it. */
	shapes: Map<object, string>
}

export function createInFlight(): InFlight {
	return { count: 0, pending: new Map(), shapes: new Map() }
}

/**
 * What the unanswered queries are, most common first: the SQL preview, how many are waiting and
 * how long the oldest of them has waited. Never parameters.
 */
export function describeInFlight(
	load: InFlight,
	top = 5,
	now = performance.now(),
): { sql: string; count: number; oldestMs: number }[] {
	const groups = new Map<string, { count: number; oldestMs: number }>()
	for (const [query, startedAt] of load.pending) {
		const sqlText = load.shapes.get(query) ?? ''
		const group = groups.get(sqlText) ?? { count: 0, oldestMs: 0 }
		group.count += 1
		group.oldestMs = Math.max(group.oldestMs, Math.round(now - startedAt))
		groups.set(sqlText, group)
	}
	return [...groups]
		.map(([sqlText, g]) => ({ sql: sqlText, ...g }))
		.sort((a, b) => b.count - a.count)
		.slice(0, top)
}

/**
 * How many queries have been waiting longer than `olderThanMs`, counted up to `upTo`. A queue
 * of them means the pool is backed up; one long query (a nightly sweep) does not.
 */
export function countStalledQueries(
	load: InFlight,
	olderThanMs: number,
	upTo: number,
	now = performance.now(),
): number {
	let n = 0
	// The map is in the order queries were sent, so the first one younger than the limit ends it.
	for (const startedAt of load.pending.values()) {
		if (now - startedAt < olderThanMs) break
		n += 1
		if (n >= upTo) break
	}
	return n
}

type QueryGuards = {
	onQuery?: QueryTimer
	queryTimeoutMs?: number
	/** Deadline for a query sent when `saturationAt` queries are already in flight. */
	queuedQueryTimeoutMs?: number
	onQueryTimeout?: (info: QueryTimeoutInfo) => void
	/** Called each time the in-flight count rises to `saturationAt`. */
	onSaturated?: (inFlight: number) => void
	saturationAt?: number
	inFlight: InFlight
}

const SQL_PREVIEW_CHARS = 80

// postgres.js queries are lazy thenables: nothing is sent until `then` runs. Time from there to
// the result, so the figure includes any wait for a pooled connection. Past the deadline, reject
// and cancel so the caller fails fast instead of hanging until the proxy gives up.
function timeQuery<T extends PromiseLike<unknown>>(
	query: T,
	{
		onQuery,
		queryTimeoutMs,
		queuedQueryTimeoutMs,
		onQueryTimeout,
		onSaturated,
		saturationAt,
		inFlight,
	}: QueryGuards,
	sqlText: string,
): T {
	const originalThen = query.then.bind(query)
	// A query can be awaited, caught and finally-ed, and each of those reaches `then`. It is sent,
	// timed and counted once, on the first of them; the rest share that result.
	let guarded: PromiseLike<unknown> | undefined
	const begin = (): PromiseLike<unknown> => {
		const start = performance.now()
		inFlight.count += 1
		inFlight.pending.set(query, start)
		inFlight.shapes.set(query, sqlText.slice(0, SQL_PREVIEW_CHARS))
		if (saturationAt && inFlight.count === saturationAt) onSaturated?.(inFlight.count)
		// Past the pool size this query is queued behind others, so it gets the shorter deadline.
		const deadlineMs =
			queryTimeoutMs && queuedQueryTimeoutMs && saturationAt && inFlight.count > saturationAt
				? Math.min(queryTimeoutMs, queuedQueryTimeoutMs)
				: queryTimeoutMs
		const record = () => {
			if (!inFlight.pending.delete(query)) return
			inFlight.shapes.delete(query)
			inFlight.count -= 1
			onQuery?.(performance.now() - start)
		}
		let result: PromiseLike<unknown> = originalThen()
		if (deadlineMs && deadlineMs > 0) {
			let timer: NodeJS.Timeout | undefined
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					onQueryTimeout?.({
						timeoutMs: deadlineMs,
						inFlight: inFlight.count,
						sql: sqlText.slice(0, SQL_PREVIEW_CHARS),
					})
					const cancel = (query as { cancel?: () => unknown }).cancel
					try {
						cancel?.call(query)
					} catch {
						// the connection is already unusable; the rejection below is what matters
					}
					reject(new QueryTimeoutError(deadlineMs))
				}, deadlineMs)
				timer.unref?.()
			})
			result = Promise.race([result, deadline]).finally(() => clearTimeout(timer))
		}
		return result.then(
			(value) => {
				record()
				return value
			},
			(err) => {
				record()
				throw err
			},
		)
	}
	// biome-ignore lint/suspicious/noThenProperty: wrapping the lazy thenable postgres.js returns
	query.then = ((onFulfilled, onRejected) => {
		guarded ??= begin()
		return guarded.then(onFulfilled, onRejected)
	}) as T['then']
	return query
}

/**
 * Wraps a postgres.js client so every query drizzle sends through `unsafe` (including those inside
 * `begin` / `savepoint` transactions) reports its duration to `onQuery` and is bounded by
 * `queryTimeoutMs`.
 */
export type TimeQueriesOptions = {
	queryTimeoutMs?: number
	/** Deadline for a query sent when `saturationAt` queries are already in flight. */
	queuedQueryTimeoutMs?: number
	/** Called when a query hits the deadline, before it is cancelled and rejected. */
	onQueryTimeout?: (info: QueryTimeoutInfo) => void
	/** Called when the in-flight count rises to `saturationAt`, i.e. every pooled connection is busy. */
	onSaturated?: (inFlight: number) => void
	saturationAt?: number
	/** @internal shared with the transactions opened on this client */
	inFlight?: InFlight
}

export function timeQueries<C extends object>(
	client: C,
	onQuery?: QueryTimer,
	options: TimeQueriesOptions = {},
): C {
	const inFlight = options.inFlight ?? createInFlight()
	const shared = { ...options, inFlight }
	const guards: QueryGuards = { onQuery, ...shared }
	return new Proxy(client, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target)
			if (prop === 'unsafe' && typeof value === 'function') {
				return (...args: unknown[]) =>
					timeQuery(value.apply(target, args), guards, typeof args[0] === 'string' ? args[0] : '')
			}
			if ((prop === 'begin' || prop === 'savepoint') && typeof value === 'function') {
				return (...args: unknown[]) => {
					const last = args.length - 1
					const scope = args[last] as (tx: object) => unknown
					args[last] = (tx: object) => scope(timeQueries(tx, onQuery, shared))
					return value.apply(target, args)
				}
			}
			return value
		},
	})
}

/** postgres.js opens at most this many connections unless told otherwise. */
export const DEFAULT_POOL_SIZE = 10

/**
 * A connection the pooler or network dropped without telling us stays in postgres.js's pool with
 * its query still "in flight", and never answers. The 2026-11-10 logs show it: the database had
 * 20 connections idle and none running a query, while single queries got no answer every few
 * minutes (one within 50 s of boot), each permanently using up a connection, until all 20 were
 * gone about 25 minutes in and every query failed until the server was redeployed. postgres.js
 * cannot drop one connection, so when a query gets no answer the whole pool is replaced.
 */
export type PoolRecycleInfo = {
	/** Queries the database was running when it was asked; null if it could not be asked. */
	runningQueries: number | null
	/** The first characters of the query that got no answer. */
	sql: string
}

/** Queries the database is busy with at that moment. A backlog of real work is not a lost connection. */
export function countRunningQueries(rows: ConnectionSnapshotRow[]): number {
	return rows
		.filter((r) => r.state === 'active' && r.wait_event_type !== 'Client')
		.reduce((sum, r) => sum + r.connections, 0)
}

/** At least this many queries running at once means the database is busy, so a new pool would not help. */
export const DATABASE_BUSY_QUERIES = 5
/** At most one recycle, or one decision not to, in this long. */
export const POOL_RECYCLE_MIN_INTERVAL_MS = 30_000
const POOL_RECYCLE_PROBE_TIMEOUT_MS = 5_000

export function createDb(
	url: string,
	options: Omit<TimeQueriesOptions, 'saturationAt'> & {
		onQuery?: QueryTimer
		/** Connections to open at most. Defaults to DEFAULT_POOL_SIZE. */
		poolSize?: number
		/** Called after the pool was replaced because a query got no answer. */
		onPoolRecycled?: (info: PoolRecycleInfo) => void
		/** How the database is asked what it is running; replaceable in tests. */
		probe?: (url: string, timeoutMs: number) => Promise<ConnectionSnapshotRow[]>
		recycleProbeTimeoutMs?: number
		recycleMinIntervalMs?: number
	} = {},
) {
	const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE
	// connect_timeout, keep_alive and max_lifetime keep postgres.js's defaults (30s, 60s, 30-60min).
	// idle_timeout retires connections the pooler may have dropped silently.
	const openClient = () => postgres(url, { prepare: false, idle_timeout: 20, max: poolSize })
	let client = openClient()
	// What everything else holds on to, so the client behind it can be swapped.
	const handle = new Proxy(client, {
		get(_target, prop) {
			const value = Reflect.get(client, prop, client)
			return typeof value === 'function' ? value.bind(client) : value
		},
	})

	const probe = options.probe ?? captureConnectionSnapshot
	const minIntervalMs = options.recycleMinIntervalMs ?? POOL_RECYCLE_MIN_INTERVAL_MS
	let lastAttemptAt = Number.NEGATIVE_INFINITY
	let deciding = false
	const recycleIfLost = async (info: QueryTimeoutInfo) => {
		if (deciding || Date.now() - lastAttemptAt < minIntervalMs) return
		deciding = true
		lastAttemptAt = Date.now()
		try {
			let running: number | null = null
			try {
				running = countRunningQueries(
					await probe(url, options.recycleProbeTimeoutMs ?? POOL_RECYCLE_PROBE_TIMEOUT_MS),
				)
			} catch {
				// A fresh connection could not be asked either; a new pool cannot make that worse.
			}
			if (running !== null && running >= DATABASE_BUSY_QUERIES) return
			const next = openClient()
			// drizzle sets up the client's date and json handling when it is built; do the same here.
			drizzle(next)
			const old = client
			client = next
			// Give queries that are really running a moment, then close every socket.
			void old.end({ timeout: 2 }).catch(() => {})
			options.onPoolRecycled?.({ runningQueries: running, sql: info.sql })
		} finally {
			deciding = false
		}
	}

	return drizzle(
		timeQueries(handle, options.onQuery, {
			queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
			queuedQueryTimeoutMs: options.queuedQueryTimeoutMs ?? DEFAULT_QUEUED_QUERY_TIMEOUT_MS,
			onQueryTimeout: (info) => {
				options.onQueryTimeout?.(info)
				void recycleIfLost(info)
			},
			onSaturated: options.onSaturated,
			saturationAt: poolSize,
			// A caller that passes its own counter can read the backlog (to shed load).
			inFlight: options.inFlight,
		}),
		{ schema },
	)
}

export type Database = ReturnType<typeof createDb>

/** The `tx` parameter inside a `db.transaction(async (tx) => { ... })` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
