import type { Database } from '@maskin/db'

/**
 * Creates a mock Drizzle DB with queued results. Each db.select() call
 * shifts the next result from the queue, falling back to empty array.
 *
 * Uses .then on the chain to make it thenable, which is how Drizzle
 * resolves queries via await. If Drizzle changes its execution model,
 * these mocks will need updating.
 */
export function createMockDb(queue: unknown[][]) {
	const remaining = [...queue]

	return new Proxy({} as Database, {
		get: (_target, prop) => {
			if (prop === 'select') {
				return () => {
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
