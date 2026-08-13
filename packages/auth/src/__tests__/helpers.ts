import type { Database } from '@maskin/db'

/** Property on the mock DB that exposes how many times `select()` was called. */
export const SELECT_CALL_COUNT = '__selectCallCount'

/**
 * Creates a mock Drizzle DB with queued results. Each db.select() call
 * shifts the next result from the queue, falling back to empty array.
 *
 * Uses .then on the chain to make it thenable, which is how Drizzle
 * resolves queries via await. If Drizzle changes its execution model,
 * these mocks will need updating.
 *
 * The mock also tracks how many times `select()` was called, readable via
 * `db[SELECT_CALL_COUNT]` — use this to assert that a short-circuit (e.g. a
 * validation guard before a query) actually skipped the DB call, rather than
 * just happening to produce the same result as a query that ran and returned
 * an empty/fallback row.
 */
export function createMockDb(queue: unknown[][]) {
	const remaining = [...queue]
	let selectCallCount = 0

	return new Proxy({} as Database, {
		get: (_target, prop) => {
			if (prop === SELECT_CALL_COUNT) {
				return selectCallCount
			}
			if (prop === 'select') {
				return () => {
					selectCallCount++
					const rows = remaining.shift() ?? []
					const chain: Record<string, unknown> = {}
					const methods = ['select', 'from', 'where', 'limit']
					for (const m of methods) {
						chain[m] = () => chain
					}
					// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle await
					chain.then = (resolve: (v: unknown) => void) => resolve(rows)
					return chain
				}
			}
			return () => ({})
		},
	})
}
