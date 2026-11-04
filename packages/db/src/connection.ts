import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

type QueryTimer = (ms: number) => void

// postgres.js queries are lazy thenables: nothing is sent until `then` runs. Time from there to
// the result, so the figure includes any wait for a pooled connection.
function timeQuery<T extends PromiseLike<unknown>>(query: T, onQuery: QueryTimer): T {
	const originalThen = query.then.bind(query)
	let recorded = false
	// biome-ignore lint/suspicious/noThenProperty: wrapping the lazy thenable postgres.js returns
	query.then = ((onFulfilled, onRejected) => {
		const start = performance.now()
		const record = () => {
			if (recorded) return
			recorded = true
			onQuery(performance.now() - start)
		}
		return originalThen(
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
 * Wraps a postgres.js client so `onQuery` gets the duration of every query drizzle sends through
 * `unsafe`, including those inside `begin` / `savepoint` transactions.
 */
export function timeQueries<C extends object>(client: C, onQuery: QueryTimer): C {
	return new Proxy(client, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target)
			if (prop === 'unsafe' && typeof value === 'function') {
				return (...args: unknown[]) => timeQuery(value.apply(target, args), onQuery)
			}
			if ((prop === 'begin' || prop === 'savepoint') && typeof value === 'function') {
				return (...args: unknown[]) => {
					const last = args.length - 1
					const scope = args[last] as (tx: object) => unknown
					args[last] = (tx: object) => scope(timeQueries(tx, onQuery))
					return value.apply(target, args)
				}
			}
			return value
		},
	})
}

export function createDb(url: string, options: { onQuery?: QueryTimer } = {}) {
	const client = postgres(url, { prepare: false })
	return drizzle(options.onQuery ? timeQueries(client, options.onQuery) : client, { schema })
}

export type Database = ReturnType<typeof createDb>

/** The `tx` parameter inside a `db.transaction(async (tx) => { ... })` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
