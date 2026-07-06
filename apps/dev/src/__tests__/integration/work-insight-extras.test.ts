import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workInsightExtras } from '@maskin/ext-work/db-schema'
import { and, eq, isNull } from 'drizzle-orm'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationPath = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0049_work_insight_extras.sql',
)
const rollbackPath = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'rollbacks',
	'0049_work_insight_extras.sql',
)

async function seedInsight(
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	return insertObject(db, workspaceId, actorId, {
		type: 'insight',
		status: 'new',
		...overrides,
	})
}

describe('work_insight_extras — migration + column filters + backfill', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	// ── Schema shape ──────────────────────────────────────────────────────────

	it('table exists with FK CASCADE on object_id', async () => {
		const [row] = await sql`
			SELECT c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.work_insight_extras'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.work_insight_extras'::regclass AND attname = 'object_id')
				]::int2[]
		`
		expect(row?.confdeltype, 'work_insight_extras.object_id FK must be ON DELETE CASCADE').toBe('c')
	})

	it('deleting the parent object cascades the extras row', async () => {
		const i = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values({
			objectId: i.id,
			workspaceId,
			strength: 'moderate',
		})
		await sql`DELETE FROM objects WHERE id = ${i.id}`
		const [row] = await sql`SELECT * FROM work_insight_extras WHERE object_id = ${i.id}`
		expect(row).toBeUndefined()
	})

	// Raw sql (postgres.js) is used for these CHECK assertions so the underlying
	// PostgresError surfaces directly. Drizzle wraps failed inserts in a
	// DrizzleQueryError whose `.message` is only `Failed query: <sql>\nparams: ...`
	// — the original constraint name lives on `.cause`, which `.rejects.toThrow`
	// does not walk. Raw sql skips that wrapper.

	it('enforces CHECK on strength enum', async () => {
		const i = await seedInsight(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_insight_extras (object_id, workspace_id, strength)
				VALUES (${i.id}, ${workspaceId}, 'overwhelming')
			`,
		).rejects.toThrow(/work_insight_extras_strength_ck/)
	})

	it('enforces CHECK on anchor enum', async () => {
		const i = await seedInsight(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_insight_extras (object_id, workspace_id, anchor)
				VALUES (${i.id}, ${workspaceId}, '#6')
			`,
		).rejects.toThrow(/work_insight_extras_anchor_ck/)
	})

	it('enforces CHECK on feedback_source enum', async () => {
		const i = await seedInsight(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_insight_extras (object_id, workspace_id, feedback_source)
				VALUES (${i.id}, ${workspaceId}, 'twitter')
			`,
		).rejects.toThrow(/work_insight_extras_feedback_source_ck/)
	})

	it('accepts NULLs on every promoted column', async () => {
		const i = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values({ objectId: i.id, workspaceId })
		const [row] = await db
			.select()
			.from(workInsightExtras)
			.where(eq(workInsightExtras.objectId, i.id))
		expect(row?.theme).toBeNull()
		expect(row?.strength).toBeNull()
		expect(row?.anchor).toBeNull()
		expect(row?.feedbackSource).toBeNull()
	})

	// ── Column filters ────────────────────────────────────────────────────────

	it('filters by theme', async () => {
		const activation = await seedInsight(workspaceId, getTestActorId())
		const churn = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values([
			{ objectId: activation.id, workspaceId, theme: 'activation' },
			{ objectId: churn.id, workspaceId, theme: 'churn' },
		])
		const rows = await db
			.select({ id: workInsightExtras.objectId })
			.from(workInsightExtras)
			.where(
				and(
					eq(workInsightExtras.workspaceId, workspaceId),
					eq(workInsightExtras.theme, 'activation'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([activation.id])
	})

	it('filters by strength', async () => {
		const weak = await seedInsight(workspaceId, getTestActorId())
		const strong = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values([
			{ objectId: weak.id, workspaceId, strength: 'weak' },
			{ objectId: strong.id, workspaceId, strength: 'strong' },
		])
		const rows = await db
			.select({ id: workInsightExtras.objectId })
			.from(workInsightExtras)
			.where(
				and(
					eq(workInsightExtras.workspaceId, workspaceId),
					eq(workInsightExtras.strength, 'strong'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([strong.id])
	})

	it('filters by anchor', async () => {
		const a1 = await seedInsight(workspaceId, getTestActorId())
		const a3 = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values([
			{ objectId: a1.id, workspaceId, anchor: '#1' },
			{ objectId: a3.id, workspaceId, anchor: '#3' },
		])
		const rows = await db
			.select({ id: workInsightExtras.objectId })
			.from(workInsightExtras)
			.where(
				and(eq(workInsightExtras.workspaceId, workspaceId), eq(workInsightExtras.anchor, '#3')),
			)
		expect(rows.map((r) => r.id)).toEqual([a3.id])
	})

	it('filters by feedback_source', async () => {
		const slack = await seedInsight(workspaceId, getTestActorId())
		const meeting = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values([
			{ objectId: slack.id, workspaceId, feedbackSource: 'slack' },
			{ objectId: meeting.id, workspaceId, feedbackSource: 'meeting' },
		])
		const rows = await db
			.select({ id: workInsightExtras.objectId })
			.from(workInsightExtras)
			.where(
				and(
					eq(workInsightExtras.workspaceId, workspaceId),
					eq(workInsightExtras.feedbackSource, 'slack'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([slack.id])
	})

	it('filters by anchor IS NULL — insights missing a strategic anchor', async () => {
		const anchored = await seedInsight(workspaceId, getTestActorId())
		const orphan = await seedInsight(workspaceId, getTestActorId())
		await db.insert(workInsightExtras).values([
			{ objectId: anchored.id, workspaceId, anchor: '#2' },
			{ objectId: orphan.id, workspaceId },
		])
		const rows = await db
			.select({ id: workInsightExtras.objectId })
			.from(workInsightExtras)
			.where(and(eq(workInsightExtras.workspaceId, workspaceId), isNull(workInsightExtras.anchor)))
		expect(rows.map((r) => r.id)).toEqual([orphan.id])
	})

	// ── Backfill (idempotent replay) ──────────────────────────────────────────

	it('backfill promotes metadata.* into first-class columns for existing insights', async () => {
		const clean = await seedInsight(workspaceId, getTestActorId(), {
			metadata: {
				theme: 'activation',
				strength: 'strong',
				anchor: '#3',
				feedback_source: 'slack',
			},
		})
		const partial = await seedInsight(workspaceId, getTestActorId(), {
			metadata: { theme: 'churn' },
		})
		const outOfEnum = await seedInsight(workspaceId, getTestActorId(), {
			metadata: {
				theme: '', // empty → NULL via NULLIF
				strength: 'overwhelming', // out-of-enum → NULL
				anchor: '#6', // out-of-enum → NULL
				feedback_source: 'twitter', // out-of-enum → 'other'
			},
		})
		const empty = await seedInsight(workspaceId, getTestActorId())

		// Non-insight objects must not get an extras row.
		const bet = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			status: 'signal',
			metadata: { theme: 'ignored' },
		})

		// Re-run only the INSERT SELECT half. ON CONFLICT DO NOTHING keeps this
		// idempotent against the initial (empty) backfill on the fresh schema.
		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "work_insight_extras"')
		expect(insertStart).toBeGreaterThan(0)
		await sql.unsafe(migrationSql.slice(insertStart))

		const rows = await db
			.select()
			.from(workInsightExtras)
			.where(eq(workInsightExtras.workspaceId, workspaceId))
		const byId = new Map(rows.map((r) => [r.objectId, r]))

		expect(byId.get(clean.id)?.theme).toBe('activation')
		expect(byId.get(clean.id)?.strength).toBe('strong')
		expect(byId.get(clean.id)?.anchor).toBe('#3')
		expect(byId.get(clean.id)?.feedbackSource).toBe('slack')

		expect(byId.get(partial.id)?.theme).toBe('churn')
		expect(byId.get(partial.id)?.strength).toBeNull()
		expect(byId.get(partial.id)?.anchor).toBeNull()
		expect(byId.get(partial.id)?.feedbackSource).toBeNull()

		expect(byId.get(outOfEnum.id)?.theme).toBeNull() // empty string coalesced
		expect(byId.get(outOfEnum.id)?.strength).toBeNull()
		expect(byId.get(outOfEnum.id)?.anchor).toBeNull()
		expect(byId.get(outOfEnum.id)?.feedbackSource).toBe('other') // coalesced

		// Empty metadata → row exists with all NULLs.
		expect(byId.has(empty.id)).toBe(true)
		expect(byId.get(empty.id)?.theme).toBeNull()

		// Non-insight types get no row.
		expect(byId.has(bet.id)).toBe(false)
	})

	it('backfill leaves objects.metadata byte-identical (COPY, not MOVE)', async () => {
		const metadata = {
			theme: 'activation',
			strength: 'strong',
			anchor: '#3',
			feedback_source: 'slack',
		}
		const i = await seedInsight(workspaceId, getTestActorId(), { metadata })

		const [before] = await sql`SELECT metadata FROM objects WHERE id = ${i.id}`

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "work_insight_extras"')
		await sql.unsafe(migrationSql.slice(insertStart))

		const [after] = await sql`SELECT metadata FROM objects WHERE id = ${i.id}`
		expect(after?.metadata).toEqual(before?.metadata)
	})

	// ── Reversibility ─────────────────────────────────────────────────────────

	it('up → down → up is byte-equal (table, indexes, constraints re-created identically)', async () => {
		// Comparing postgres.js Result instances (Array subclasses carrying
		// non-enumerable metadata like `count` and `statement`) with `toEqual`
		// is brittle. Normalise to plain rows first, then compare.
		type Row = Record<string, unknown>
		const asRows = (r: readonly Row[]): Row[] => r.map((row) => ({ ...row }))

		async function snapshot() {
			const cols = await sql<Row[]>`
				SELECT column_name, data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'work_insight_extras'
				ORDER BY column_name
			`
			const constraints = await sql<Row[]>`
				SELECT conname, contype, pg_get_constraintdef(oid) AS def
				FROM pg_constraint
				WHERE conrelid = 'public.work_insight_extras'::regclass
				ORDER BY conname
			`
			const indexes = await sql<Row[]>`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = 'public' AND tablename = 'work_insight_extras'
				ORDER BY indexname
			`
			return {
				cols: asRows(cols),
				constraints: asRows(constraints),
				indexes: asRows(indexes),
			}
		}

		const before = await snapshot()

		const rollbackSql = readFileSync(rollbackPath, 'utf-8')
		await sql.unsafe(rollbackSql)

		const [gone] = await sql`SELECT to_regclass('public.work_insight_extras') AS oid`
		expect(gone?.oid).toBeNull()

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		await sql.unsafe(migrationSql)

		const after = await snapshot()

		expect(after.cols, 'columns diverged after up → down → up').toEqual(before.cols)
		expect(after.constraints, 'constraints diverged after up → down → up').toEqual(
			before.constraints,
		)
		expect(after.indexes, 'indexes diverged after up → down → up').toEqual(before.indexes)
	})
})
