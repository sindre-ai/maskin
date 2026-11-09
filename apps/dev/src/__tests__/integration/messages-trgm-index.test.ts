import { sql } from './global-setup'

/**
 * Migrations 0122 to 0124 give the message-text search (services/search.ts, deepHit) a trigram
 * index. Without it every typed word reads every message of every chat in the scan cap. Pins that
 * the index exists, is valid, and that the planner can use it for the ILIKE the search issues.
 */
describe('messages content trigram index', () => {
	it('exists and is valid', async () => {
		const rows = await sql<{ indexdef: string; indisvalid: boolean }[]>`
			SELECT i.indexdef, x.indisvalid
			FROM pg_indexes i
			INNER JOIN pg_class c ON c.relname = i.indexname
			INNER JOIN pg_index x ON x.indexrelid = c.oid
			WHERE i.schemaname = 'public' AND i.indexname = 'messages_conv_content_trgm_idx'
		`
		expect(rows).toHaveLength(1)
		expect(rows[0]?.indisvalid).toBe(true)
		expect(rows[0]?.indexdef).toMatch(/USING gin \(conversation_id, content gin_trgm_ops\)/)
	})

	it('can answer the ILIKE the message search issues', async () => {
		// SET LOCAL inside one transaction: the pool may hand each statement a different connection.
		const plan = await sql.begin(async (tx) => {
			await tx`SET LOCAL enable_seqscan = off`
			return tx<{ 'QUERY PLAN': string }[]>`
				EXPLAIN SELECT 1 FROM messages dm WHERE dm.content ILIKE '%supabase%'
			`
		})
		expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('messages_conv_content_trgm_idx')
	})
})
