import { TransactionRollbackError, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from './global-setup'

const INDEX_NAME = 'events_commented_mentions_idx'

describe('events_commented_mentions_idx (migration 0142)', () => {
	it('exists, is valid, and is a partial GIN index over the mentions array', async () => {
		const rows = await db.execute<{ indexdef: string; indisvalid: boolean }>(sql`
			SELECT pg_indexes.indexdef, pg_index.indisvalid
			FROM pg_indexes
			JOIN pg_class ON pg_class.relname = pg_indexes.indexname
			JOIN pg_index ON pg_index.indexrelid = pg_class.oid
			WHERE pg_indexes.tablename = 'events' AND pg_indexes.indexname = ${INDEX_NAME}`)
		const [row] = Array.from(rows)
		expect(row).toBeDefined()
		expect(row?.indisvalid).toBe(true)
		expect(row?.indexdef).toContain('USING gin')
		expect(row?.indexdef).toContain("(data -> 'mentions'::text)")
		expect(row?.indexdef).toContain("(action = 'commented'::text)")
	})

	it('is what the planner picks for the predicate the unread feed and decision cards send', async () => {
		// The index only helps if the query's expression matches it. On a tiny test table the planner
		// would rather read the whole comments-only partial index events_ws_entity_commented_idx (or
		// scan the table), so rule both out inside a transaction that is rolled back, and see
		// whether the mentions index is what is left to reach for.
		let plan = ''
		await db
			.transaction(async (tx) => {
				await tx.execute(sql`SET LOCAL enable_seqscan = off`)
				await tx.execute(sql`DROP INDEX events_ws_entity_commented_idx`)
				const rows = await tx.execute<{ 'QUERY PLAN': string }>(
					sql.raw(`EXPLAIN SELECT id FROM events
					WHERE action = 'commented'
					AND data->'mentions' @> jsonb_build_array('00000000-0000-0000-0000-000000000000'::text)`),
				)
				plan = Array.from(rows)
					.map((r) => r['QUERY PLAN'])
					.join('\n')
				tx.rollback()
			})
			.catch((err) => {
				if (!(err instanceof TransactionRollbackError)) throw err
			})
		expect(plan).toContain(INDEX_NAME)
	})
})
