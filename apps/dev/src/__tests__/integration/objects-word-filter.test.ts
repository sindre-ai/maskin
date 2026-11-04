import { objects } from '@maskin/db/schema'
import type { SearchQuery } from '@maskin/shared'
import { buildObject, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const { SEARCH_SOURCES, runSearch } = await import('../../services/search')

/**
 * Migrations 0129 and 0130 give the objects source of the search (services/search.ts) trigram
 * indexes on title and content, and the source now keeps only the objects holding every word inside
 * its candidates query so the indexes can answer it. Pins that the indexes exist and are used, and
 * that the filter changes no result: same rows, counts and order with and without it.
 */
describe('objects word filter and trigram indexes', () => {
	it.each([
		['objects_ws_title_trgm_idx', 'title'],
		['objects_ws_content_trgm_idx', 'content'],
	])('%s exists and is valid', async (name, column) => {
		const rows = await sql<{ indexdef: string; indisvalid: boolean }[]>`
			SELECT i.indexdef, x.indisvalid
			FROM pg_indexes i
			INNER JOIN pg_class c ON c.relname = i.indexname
			INNER JOIN pg_index x ON x.indexrelid = c.oid
			WHERE i.schemaname = 'public' AND i.indexname = ${name}
		`
		expect(rows).toHaveLength(1)
		expect(rows[0]?.indisvalid).toBe(true)
		expect(rows[0]?.indexdef).toContain(`USING gin (workspace_id, ${column} gin_trgm_ops)`)
	})

	it('can answer the filter the objects source issues, for title and for content', async () => {
		// SET LOCAL inside one transaction: the pool may hand each statement a different connection.
		const plan = await sql.begin(async (tx) => {
			await tx`SET LOCAL enable_seqscan = off`
			return tx<{ 'QUERY PLAN': string }[]>`
				EXPLAIN SELECT 1 FROM objects o
				WHERE o.workspace_id = '00000000-0000-0000-0000-000000000000'
					AND (o.title ILIKE '%supabase%' OR o.content ILIKE '%supabase%')
			`
		})
		const text = plan.map((r) => r['QUERY PLAN']).join('\n')
		expect(text).toContain('objects_ws_title_trgm_idx')
		expect(text).toContain('objects_ws_content_trgm_idx')
	})

	it('returns the same rows, counts and order with and without the word filter', async () => {
		const actorId = getTestActorId()
		const workspaceId = (await insertWorkspace(db, actorId)).id
		const seed = [
			['Supabase migration', 'plain body'],
			['Roadmap', 'we use supabase and playwright here'],
			['Playwright setup', 'supabase notes'],
			['Unrelated', 'nothing to see'],
			[null, 'a null title with supabase in the body'],
			['100% done', 'literal percent sign'],
			['SUPABASE upper', 'Playwright upper body'],
		] as const
		await db.insert(objects).values(
			seed.map(([title, content], i) =>
				buildObject({
					workspaceId,
					createdBy: actorId,
					type: i % 2 === 0 ? 'task' : 'bet',
					status: 'todo',
					title,
					content,
					updatedAt: new Date(Date.now() - i * 60_000),
				}),
			),
		)
		const unfiltered = SEARCH_SOURCES.map((source) => {
			const { wordFiltered: _dropped, ...rest } = source
			return rest
		})
		expect(SEARCH_SOURCES.find((s) => s.key === 'objects')?.wordFiltered).toBeTypeOf('function')

		for (const q of ['supabase', 'supabase playwright', '%', 'playwright zzz', 'sup']) {
			const query: SearchQuery = { sort: 'rel', limit: 150, q }
			const ctx = { workspaceId, callerId: actorId }
			const withFilter = await runSearch(db, ctx, query)
			const without = await runSearch(db, ctx, query, unfiltered)
			expect(withFilter.results, q).toEqual(without.results)
			expect(withFilter.total, q).toBe(without.total)
			expect(withFilter.facets, q).toEqual(without.facets)
			expect(withFilter.partial, q).toEqual(without.partial)
		}
		const found = await runSearch(
			db,
			{ workspaceId, callerId: actorId },
			{ sort: 'rel', limit: 150, q: 'supabase' },
		)
		expect(found.results.map((r) => r.title).sort()).toEqual(
			['Playwright setup', 'Roadmap', 'SUPABASE upper', 'Supabase migration', ''].sort(),
		)
	})
})
