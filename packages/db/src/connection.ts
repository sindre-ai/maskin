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

type QueryGuards = { onQuery?: QueryTimer; queryTimeoutMs?: number }

// postgres.js queries are lazy thenables: nothing is sent until `then` runs. Time from there to
// the result, so the figure includes any wait for a pooled connection. Past the deadline, reject
// and cancel so the caller fails fast instead of hanging until the proxy gives up.
function timeQuery<T extends PromiseLike<unknown>>(
	query: T,
	{ onQuery, queryTimeoutMs }: QueryGuards,
): T {
	const originalThen = query.then.bind(query)
	let recorded = false
	// biome-ignore lint/suspicious/noThenProperty: wrapping the lazy thenable postgres.js returns
	query.then = ((onFulfilled, onRejected) => {
		const start = performance.now()
		const record = () => {
			if (recorded) return
			recorded = true
			onQuery?.(performance.now() - start)
		}
		let guarded: PromiseLike<unknown> = originalThen()
		if (queryTimeoutMs && queryTimeoutMs > 0) {
			let timer: NodeJS.Timeout | undefined
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
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
export function timeQueries<C extends object>(
	client: C,
	onQuery?: QueryTimer,
	options: { queryTimeoutMs?: number } = {},
): C {
	const guards: QueryGuards = { onQuery, queryTimeoutMs: options.queryTimeoutMs }
	return new Proxy(client, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target)
			if (prop === 'unsafe' && typeof value === 'function') {
				return (...args: unknown[]) => timeQuery(value.apply(target, args), guards)
			}
			if ((prop === 'begin' || prop === 'savepoint') && typeof value === 'function') {
				return (...args: unknown[]) => {
					const last = args.length - 1
					const scope = args[last] as (tx: object) => unknown
					args[last] = (tx: object) => scope(timeQueries(tx, onQuery, options))
					return value.apply(target, args)
				}
			}
			return value
		},
	})
}

export function createDb(
	url: string,
	options: { onQuery?: QueryTimer; queryTimeoutMs?: number } = {},
) {
	// connect_timeout, keep_alive and max_lifetime keep postgres.js's defaults (30s, 60s, 30-60min).
	// idle_timeout retires connections the pooler may have dropped silently.
	const client = postgres(url, { prepare: false, idle_timeout: 20 })
	return drizzle(
		timeQueries(client, options.onQuery, {
			queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
		}),
		{ schema },
	)
}

export type Database = ReturnType<typeof createDb>

/** The `tx` parameter inside a `db.transaction(async (tx) => { ... })` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
