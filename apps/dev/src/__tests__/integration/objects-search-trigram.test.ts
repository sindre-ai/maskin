import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { buildObjectListConditions, tokenRankOrderBy } from '../../routes/objects'
import { insertActor, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * Migrations 0146 and 0147 add plain trigram indexes on objects.title and objects.content for the
 * object search (GET /api/objects/search and the `q` filter of GET /api/objects). The workspace-keyed
 * pair from 0129/0130 is not picked by the planner for that query (the plan only used its
 * workspace_id key and filtered every ILIKE over the workspace), so these pin three things:
 * the indexes exist and are valid, the real search query can be answered by them (BitmapOr of two
 * Bitmap Index Scans), and using them changes neither the rows nor their order.
 */

/** The statement the search route issues for `q` (list conditions + rank ORDER BY, LIMIT 20). */
function searchStatement(workspaceId: string, q: string, includeArchived = false) {
	const { conditions, searchRankExpr } = buildObjectListConditions({
		q,
		include_archived: includeArchived,
	})
	return db
		.select({ id: objects.id })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), ...conditions))
		.orderBy(...tokenRankOrderBy(searchRankExpr as never))
		.limit(20)
		.toSQL()
}

type Settings = 'default' | 'indexes-off'

async function run(text: string, params: unknown[], settings: Settings) {
	return sql.begin(async (tx) => {
		// SET LOCAL inside one transaction: the pool may hand each statement a different connection.
		if (settings === 'indexes-off') {
			await tx.unsafe('SET LOCAL enable_indexscan = off')
			await tx.unsafe('SET LOCAL enable_bitmapscan = off')
		}
		return tx.unsafe(text, params as never[])
	})
}

/** Seeds the searched workspace and a second one; returns the searched workspace id. */
async function seed(): Promise<string> {
	{
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id)
		const other = await insertWorkspace(db, actor.id)
		// Production-shaped enough for the planner to prefer trigram bitmaps over the workspace
		// btree: ~6,000 objects, bodies of ~80 words from a skewed vocabulary (a few common words,
		// many rare ones), 5/6 of the rows in the searched workspace. Some titles match, some
		// bodies are NULL, some rows are archived, one marker word is rare, one carries LIKE
		// wildcards. The bodies sit out of line (TOAST) like real ones, which is exactly why the
		// planner underestimates a scan of the workspace.
		await sql.begin(async (tx) => {
			// One connection for the temp function and the insert.
			await tx.unsafe(
				`CREATE OR REPLACE FUNCTION pg_temp.vw(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
				SELECT CASE k WHEN 1 THEN 'agent' WHEN 2 THEN 'review' WHEN 3 THEN 'customer'
					WHEN 4 THEN 'invoice' WHEN 5 THEN 'roadmap' WHEN 300 THEN 'supabase'
					ELSE 'w' || substr(md5(k::text), 1, 6) END $$`,
			)
			await tx.unsafe(
				`INSERT INTO objects (workspace_id, type, title, content, status, created_by)
			SELECT CASE WHEN g % 6 = 0 THEN $2::uuid ELSE $1::uuid END,
				'task',
				CASE WHEN g % 50 = 0 THEN 'Supabase ' || pg_temp.vw(1 + g % 5) || ' plan'
					ELSE 'Item ' || g || ' ' || pg_temp.vw(1 + floor(power(random(), 2) * 2999)::int) END,
				CASE WHEN g % 211 = 0 THEN NULL ELSE
					(SELECT string_agg(pg_temp.vw(1 + floor(power(random(), 3) * 2999 + 0 * s + 0 * g)::int), ' ')
						FROM generate_series(1, 80) s)
					|| CASE WHEN g % 97 = 0 THEN ' rarequartz' ELSE '' END
					|| CASE WHEN g % 389 = 0 THEN ' 100% done_ok' ELSE '' END END,
				CASE WHEN g % 40 = 0 THEN 'archived' ELSE 'open' END,
				$3::uuid
			FROM generate_series(1, 6000) g`,
				[ws.id, other.id, actor.id],
			)
		})
		await sql.unsafe('ANALYZE objects')
		return ws.id
	}
}

// Every other index the planner could answer the search with. The real table is big enough for it
// to pick the trigram bitmaps unaided (22,000 objects: see the PR), but a test table is not, so the
// plan check removes the competitors inside a transaction that is rolled back.
const COMPETING_INDEXES = [
	'objects_ws_type_status_idx',
	'objects_ws_updated_at_idx',
	'objects_ws_updated_at_ms_idx',
	'objects_ws_title_trgm_idx',
	'objects_ws_content_trgm_idx',
]

class Rollback extends Error {}

/** EXPLAIN as the planner would see it if only the two new trigram indexes could serve the ILIKE. */
async function explainWithOnlyNewIndexes(text: string, params: unknown[]): Promise<string> {
	let plan = ''
	try {
		await sql.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off')
			for (const name of COMPETING_INDEXES) await tx.unsafe(`DROP INDEX "${name}"`)
			const rows = await tx.unsafe(`EXPLAIN ${text}`, params as never[])
			plan = rows.map((r) => r['QUERY PLAN'] as string).join('\n')
			throw new Rollback()
		})
	} catch (e) {
		if (!(e instanceof Rollback)) throw e
	}
	return plan
}

describe('objects trigram indexes (0146, 0147)', () => {
	it('both indexes exist and are valid', async () => {
		const rows = await sql<{ indexname: string; indexdef: string; indisvalid: boolean }[]>`
			SELECT i.indexname, i.indexdef, x.indisvalid
			FROM pg_indexes i
			INNER JOIN pg_class c ON c.relname = i.indexname
			INNER JOIN pg_index x ON x.indexrelid = c.oid
			WHERE i.schemaname = 'public'
				AND i.indexname IN ('objects_title_trgm_idx', 'objects_content_trgm_idx')
			ORDER BY i.indexname
		`
		expect(rows.map((r) => r.indexname)).toEqual([
			'objects_content_trgm_idx',
			'objects_title_trgm_idx',
		])
		for (const r of rows) expect(r.indisvalid).toBe(true)
		expect(rows[0]?.indexdef).toMatch(/USING gin \(content gin_trgm_ops\)/)
		expect(rows[1]?.indexdef).toMatch(/USING gin \(title gin_trgm_ops\)/)
	})

	it('the search query reads both indexes and returns the same ids in the same order as a scan', async () => {
		const workspaceId = await seed()

		// The plan for a 1-word and a 3-word search.
		for (const q of ['rarequartz', 'rarequartz supabase roadmap']) {
			const { sql: text, params } = searchStatement(workspaceId, q)
			const plan = await explainWithOnlyNewIndexes(text, params)
			expect(plan).toContain('Bitmap Index Scan on objects_title_trgm_idx')
			expect(plan).toContain('Bitmap Index Scan on objects_content_trgm_idx')
			expect(plan).toContain('BitmapOr')
		}

		// Same rows, same order, with the indexes and with index and bitmap scans switched off.
		const queries = [
			'rarequartz',
			'supabase',
			'SUPABASE Billing',
			'rarequartz invoice roadmap',
			'agent review customer pipeline invoice roadmap webhook billing onboarding migration',
			'100% done_ok',
			'agent customer',
			'review supabase plan',
			'nomatchatall',
			'go ai',
		]
		let compared = 0
		for (const q of queries) {
			const { sql: text, params } = searchStatement(workspaceId, q)
			const withIndexes = await run(text, params, 'default')
			const withoutIndexes = await run(text, params, 'indexes-off')
			expect(withIndexes.map((r) => r.id)).toEqual(withoutIndexes.map((r) => r.id))
			compared += withIndexes.length
		}
		// Guard against a vacuous pass where every query returned nothing.
		expect(compared).toBeGreaterThan(40)
	}, 180000)
})
