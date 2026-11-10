import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from './global-setup'

async function indexRow(table: string, name: string) {
	const rows = await db.execute<{ indexdef: string; indisvalid: boolean }>(sql`
		SELECT pg_indexes.indexdef, pg_index.indisvalid
		FROM pg_indexes
		JOIN pg_class ON pg_class.relname = pg_indexes.indexname
		JOIN pg_index ON pg_index.indexrelid = pg_class.oid
		WHERE pg_indexes.tablename = ${table} AND pg_indexes.indexname = ${name}`)
	return Array.from(rows)[0]
}

describe('missing-index migrations 0143-0145', () => {
	it('relationships_target_type_idx exists, is valid, and leads with target_id', async () => {
		const row = await indexRow('relationships', 'relationships_target_type_idx')
		expect(row).toBeDefined()
		expect(row?.indisvalid).toBe(true)
		expect(row?.indexdef).toContain('(target_id, type)')
	})

	it('sessions_spawned_by_message_id_idx exists, is valid, and is partial on IS NOT NULL', async () => {
		const row = await indexRow('sessions', 'sessions_spawned_by_message_id_idx')
		expect(row).toBeDefined()
		expect(row?.indisvalid).toBe(true)
		expect(row?.indexdef).toContain('(spawned_by_message_id)')
		expect(row?.indexdef).toContain('spawned_by_message_id IS NOT NULL')
	})
})
