import { events } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { DAILY_BUDGET_SUMMARY_ACTION } from '../../services/daily-budget-events'
import { db } from './global-setup'

const INDEX_NAME = 'events_daily_budget_summary_day_idx'

describe('events_daily_budget_summary_day_idx (migration 0143)', () => {
	it('exists, is valid, and is a partial index over the workspace and the summary day', async () => {
		const rows = await db.execute<{ indexdef: string; indisvalid: boolean }>(sql`
			SELECT pg_indexes.indexdef, pg_index.indisvalid
			FROM pg_indexes
			JOIN pg_class ON pg_class.relname = pg_indexes.indexname
			JOIN pg_index ON pg_index.indexrelid = pg_class.oid
			WHERE pg_indexes.tablename = 'events' AND pg_indexes.indexname = ${INDEX_NAME}`)
		const [row] = Array.from(rows)
		expect(row).toBeDefined()
		expect(row?.indisvalid).toBe(true)
		expect(row?.indexdef).toContain('workspace_id')
		expect(row?.indexdef).toContain("(data ->> 'day'::text)")
		expect(row?.indexdef).toContain(`(action = '${DAILY_BUDGET_SUMMARY_ACTION}'::text)`)
	})

	it('is what the planner picks for the scheduler query, sent with bound parameters as the app sends it', async () => {
		// The app binds the action and the day as parameters, and a partial index only applies if
		// the planner can prove its condition from them. Build the very query the scheduler runs,
		// then explain it with its parameters. A tiny test table would otherwise be read with a
		// sequential scan, so rule that out and see what the planner can reach for.
		const query = db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, '00000000-0000-0000-0000-000000000001'),
					eq(events.action, DAILY_BUDGET_SUMMARY_ACTION),
					sql`${events.data}->>'day' = ${'2026-11-10'}`,
				),
			)
			.limit(1)
			.toSQL()

		const plan = await db.$client.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off')
			const rows = await tx.unsafe(`EXPLAIN ${query.sql}`, query.params as never[])
			return Array.from(rows as unknown as Record<string, string>[])
				.map((r) => r['QUERY PLAN'])
				.join('\n')
		})
		expect(plan).toContain(INDEX_NAME)
	})
})
