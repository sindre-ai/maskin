import type { Database, idempotencyRecords as idempotencyRecordsTable } from '@maskin/db'

type IdempotencyRow = {
	key: string
	actorId: string | null
	method: string
	path: string
	status: number
	response: Record<string, unknown>
	createdAt: Date
}

export interface IdempotencyLedgerStub {
	/** Drizzle-shaped Database stub the middleware drives without modification. */
	readonly db: Database
	/** Number of rows currently in the ledger. */
	size(): number
	/** Get a snapshot of all rows. */
	rows(): IdempotencyRow[]
}

// Walk a Drizzle SQL expression and pull every Param.value out in order. The
// middleware's two filter shapes are `eq(col, scalar)` and `lt(col, Date)`, so
// we only ever need the first scalar value to dispatch.
function extractParamValues(node: unknown): unknown[] {
	const out: unknown[] = []
	const visit = (n: unknown): void => {
		if (n === null || typeof n !== 'object') return
		const obj = n as Record<string, unknown> & { constructor?: { name?: string } }
		if (obj.constructor?.name === 'Param' && 'value' in obj) {
			out.push(obj.value)
			return
		}
		const chunks = (obj as { queryChunks?: unknown[] }).queryChunks
		if (Array.isArray(chunks)) chunks.forEach(visit)
	}
	visit(node)
	return out
}

/**
 * An in-memory fake of just enough Drizzle surface for
 * `createIdempotencyMiddleware` to operate against. The middleware uses three
 * operations: a keyed select, an insert-with-onConflictDoUpdate, and a cleanup
 * delete keyed on `createdAt < cutoff`. Everything else is intentionally
 * unsupported — if the middleware grows new queries this stub will fail loudly.
 *
 * Pass `onLookupMs` to time each select() resolution — the test uses it to
 * report idempotency-store lookup latency for the bet verdict.
 */
export function createInMemoryIdempotencyLedger(options?: {
	onLookupMs?: (ms: number) => void
}): IdempotencyLedgerStub {
	const rows = new Map<string, IdempotencyRow>()
	const onLookupMs = options?.onLookupMs

	const db = {
		select: () => {
			const state: { whereKey: string | undefined; limitN: number | undefined } = {
				whereKey: undefined,
				limitN: undefined,
			}
			const t0 = performance.now()
			const chain = {
				from: (_table: typeof idempotencyRecordsTable) => chain,
				where: (expr: unknown) => {
					const params = extractParamValues(expr)
					if (typeof params[0] !== 'string') {
						throw new Error('idempotency-fakes: select().where() expected eq(key, string)')
					}
					state.whereKey = params[0]
					return chain
				},
				limit: (n: number) => {
					state.limitN = n
					return chain
				},
				// biome-ignore lint/suspicious/noThenProperty: fake needs .then for Drizzle's await
				then: (resolve: (v: IdempotencyRow[]) => unknown) => {
					const found =
						state.whereKey !== undefined && rows.has(state.whereKey)
							? [rows.get(state.whereKey) as IdempotencyRow]
							: []
					onLookupMs?.(performance.now() - t0)
					return resolve(found.slice(0, state.limitN ?? found.length))
				},
			}
			return chain
		},
		insert: (_table: typeof idempotencyRecordsTable) => {
			let pendingValues: IdempotencyRow | undefined
			const chain = {
				values: (v: IdempotencyRow) => {
					pendingValues = { ...v, createdAt: v.createdAt ?? new Date() }
					return chain
				},
				onConflictDoUpdate: (cfg: { set: { createdAt?: unknown } }) => {
					if (!pendingValues) {
						throw new Error('idempotency-fakes: onConflictDoUpdate without values()')
					}
					const existing = rows.get(pendingValues.key)
					const overwriteCreatedAt = 'createdAt' in cfg.set
					rows.set(pendingValues.key, {
						...(existing ?? {}),
						...pendingValues,
						createdAt: overwriteCreatedAt ? new Date() : pendingValues.createdAt,
					})
					return chain
				},
				// biome-ignore lint/suspicious/noThenProperty: fake needs .then for Drizzle's await
				then: (resolve: (v: unknown) => unknown) => resolve(undefined),
			}
			return chain
		},
		delete: (_table: typeof idempotencyRecordsTable) => {
			const chain = {
				where: (expr: unknown) => {
					const params = extractParamValues(expr)
					if (params[0] instanceof Date) {
						const cutoff = params[0].getTime()
						for (const [k, v] of rows) {
							if (v.createdAt.getTime() < cutoff) rows.delete(k)
						}
					}
					return chain
				},
				// biome-ignore lint/suspicious/noThenProperty: fake needs .then for Drizzle's await
				then: (resolve: (v: unknown) => unknown) => resolve(undefined),
			}
			return chain
		},
	} as unknown as Database

	return {
		db,
		size: () => rows.size,
		rows: () => Array.from(rows.values()),
	}
}
