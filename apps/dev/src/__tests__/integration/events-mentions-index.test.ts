import { sql } from 'drizzle-orm'
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
		// The index only helps if the query's expression matches it. A tiny test table would
		// otherwise be read with a sequential scan, so rule that out and see what the planner
		// can reach for.
		const plan = await db.transaction(async (tx) => {
			await tx.execute(sql`SET LOCAL enable_seqscan = off`)
			const rows = await tx.execute<{ 'QUERY PLAN': string }>(
				sql.raw(`EXPLAIN SELECT id FROM events
					WHERE action = 'commented'
					AND data->'mentions' @> jsonb_build_array('00000000-0000-0000-0000-000000000000'::text)`),
			)
			return Array.from(rows)
				.map((r) => r['QUERY PLAN'])
				.join('\n')
		})
		expect(plan).toContain(INDEX_NAME)
	})
})
