import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

type QueryTimer = (ms: number) => void

/**
 * Longest a query may wait for its result. Above the role-level `statement_timeout` (20s on
 * Supabase) so a slow query still fails on the server first; this only fires when the server
 * never answers, e.g. a half-open connection stuck in `ClientRead`, which no server-side timer
 * covers because the query never arrived whole.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 45_000

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

/** Queries sent and not yet answered, shared by a client and the transactions opened on it. */
export type InFlight = { count: number }

type QueryGuards = {
	onQuery?: QueryTimer
	queryTimeoutMs?: number
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
	{ onQuery, queryTimeoutMs, onQueryTimeout, onSaturated, saturationAt, inFlight }: QueryGuards,
	sqlText: string,
): T {
	const originalThen = query.then.bind(query)
	let recorded = false
	// biome-ignore lint/suspicious/noThenProperty: wrapping the lazy thenable postgres.js returns
	query.then = ((onFulfilled, onRejected) => {
		const start = performance.now()
		inFlight.count += 1
		if (saturationAt && inFlight.count === saturationAt) onSaturated?.(inFlight.count)
		const record = () => {
			if (recorded) return
			recorded = true
			inFlight.count -= 1
			onQuery?.(performance.now() - start)
		}
		let guarded: PromiseLike<unknown> = originalThen()
		if (queryTimeoutMs && queryTimeoutMs > 0) {
			let timer: NodeJS.Timeout | undefined
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					onQueryTimeout?.({
						timeoutMs: queryTimeoutMs,
						inFlight: inFlight.count,
						sql: sqlText.slice(0, SQL_PREVIEW_CHARS),
					})
					const cancel = (query as { cancel?: () => unknown }).cancel
					try {
						cancel?.call(query)
					} catch {
						// the connection is already unusable; the rejection below is what matters
					}
					reject(new QueryTimeoutError(queryTimeoutMs))
				}, queryTimeoutMs)
				timer.unref?.()
			})
			guarded = Promise.race([guarded, deadline]).finally(() => clearTimeout(timer))
		}
		return guarded.then(
			(value) => {
				record()
				return onFulfilled ? onFulfilled(value) : value
			},
			(err) => {
				record()
				if (onRejected) return onRejected(err)
				throw err
			},
		)
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
	const inFlight = options.inFlight ?? { count: 0 }
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

export function createDb(
	url: string,
	options: Omit<TimeQueriesOptions, 'saturationAt'> & {
		onQuery?: QueryTimer
		/** Connections to open at most. Defaults to DEFAULT_POOL_SIZE. */
		poolSize?: number
	} = {},
) {
	const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE
	// connect_timeout, keep_alive and max_lifetime keep postgres.js's defaults (30s, 60s, 30-60min).
	// idle_timeout retires connections the pooler may have dropped silently.
	const client = postgres(url, { prepare: false, idle_timeout: 20, max: poolSize })
	return drizzle(
		timeQueries(client, options.onQuery, {
			queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
			onQueryTimeout: options.onQueryTimeout,
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
