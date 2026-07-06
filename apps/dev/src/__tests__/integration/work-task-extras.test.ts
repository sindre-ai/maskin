import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workTaskExtras } from '@maskin/ext-work/db-schema'
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
	'0050_work_task_extras.sql',
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
	'0050_work_task_extras.sql',
)

async function seedTask(workspaceId: string, actorId: string, overrides?: Record<string, unknown>) {
	return insertObject(db, workspaceId, actorId, {
		type: 'task',
		status: 'todo',
		...overrides,
	})
}

describe('work_task_extras — migration + column filters + backfill', () => {
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
			WHERE c.conrelid = 'public.work_task_extras'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.work_task_extras'::regclass AND attname = 'object_id')
				]::int2[]
		`
		expect(row?.confdeltype, 'work_task_extras.object_id FK must be ON DELETE CASCADE').toBe('c')
	})

	it('deleting the parent object cascades the extras row', async () => {
		const t = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values({
			objectId: t.id,
			workspaceId,
			decisionType: 'architecture',
		})
		await sql`DELETE FROM objects WHERE id = ${t.id}`
		const [row] = await sql`SELECT * FROM work_task_extras WHERE object_id = ${t.id}`
		expect(row).toBeUndefined()
	})

	// Raw sql (postgres.js) is used for these CHECK assertions so the underlying
	// PostgresError surfaces directly. Drizzle wraps failed inserts in a
	// DrizzleQueryError whose `.message` is only `Failed query: <sql>\nparams: ...`
	// — the original constraint name lives on `.cause`, which `.rejects.toThrow`
	// does not walk. Raw sql skips that wrapper.

	it('enforces CHECK on decision_type enum', async () => {
		const t = await seedTask(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_task_extras (object_id, workspace_id, decision_type)
				VALUES (${t.id}, ${workspaceId}, 'infra')
			`,
		).rejects.toThrow(/work_task_extras_decision_type_ck/)
	})

	it('enforces CHECK on explore_phase enum', async () => {
		const t = await seedTask(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_task_extras (object_id, workspace_id, explore_phase)
				VALUES (${t.id}, ${workspaceId}, 'hypothesis')
			`,
		).rejects.toThrow(/work_task_extras_explore_phase_ck/)
	})

	it('accepts NULLs on every promoted column', async () => {
		const t = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values({ objectId: t.id, workspaceId })
		const [row] = await db.select().from(workTaskExtras).where(eq(workTaskExtras.objectId, t.id))
		expect(row?.decisionType).toBeNull()
		expect(row?.explorePhase).toBeNull()
		expect(row?.exploreCandidate).toBeNull()
		expect(row?.exploreBetId).toBeNull()
	})

	// ── Column filters ────────────────────────────────────────────────────────

	it('filters by decision_type', async () => {
		const arch = await seedTask(workspaceId, getTestActorId())
		const ux = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values([
			{ objectId: arch.id, workspaceId, decisionType: 'architecture' },
			{ objectId: ux.id, workspaceId, decisionType: 'ux' },
		])
		const rows = await db
			.select({ id: workTaskExtras.objectId })
			.from(workTaskExtras)
			.where(
				and(eq(workTaskExtras.workspaceId, workspaceId), eq(workTaskExtras.decisionType, 'ux')),
			)
		expect(rows.map((r) => r.id)).toEqual([ux.id])
	})

	it('filters by explore_phase', async () => {
		const root = await seedTask(workspaceId, getTestActorId())
		const solution = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values([
			{ objectId: root.id, workspaceId, explorePhase: 'root_cause' },
			{ objectId: solution.id, workspaceId, explorePhase: 'solution' },
		])
		const rows = await db
			.select({ id: workTaskExtras.objectId })
			.from(workTaskExtras)
			.where(
				and(
					eq(workTaskExtras.workspaceId, workspaceId),
					eq(workTaskExtras.explorePhase, 'solution'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([solution.id])
	})

	it('filters by explore_candidate = true', async () => {
		const yes = await seedTask(workspaceId, getTestActorId())
		const no = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values([
			{ objectId: yes.id, workspaceId, exploreCandidate: true },
			{ objectId: no.id, workspaceId, exploreCandidate: false },
		])
		const rows = await db
			.select({ id: workTaskExtras.objectId })
			.from(workTaskExtras)
			.where(
				and(eq(workTaskExtras.workspaceId, workspaceId), eq(workTaskExtras.exploreCandidate, true)),
			)
		expect(rows.map((r) => r.id)).toEqual([yes.id])
	})

	it('filters by explore_bet_id', async () => {
		const targetBetId = '11111111-1111-1111-1111-111111111111'
		const otherBetId = '22222222-2222-2222-2222-222222222222'
		const match = await seedTask(workspaceId, getTestActorId())
		const other = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values([
			{ objectId: match.id, workspaceId, exploreBetId: targetBetId },
			{ objectId: other.id, workspaceId, exploreBetId: otherBetId },
		])
		const rows = await db
			.select({ id: workTaskExtras.objectId })
			.from(workTaskExtras)
			.where(
				and(
					eq(workTaskExtras.workspaceId, workspaceId),
					eq(workTaskExtras.exploreBetId, targetBetId),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([match.id])
	})

	it('filters by decision_type IS NULL — coding tasks (no decision routing)', async () => {
		const decision = await seedTask(workspaceId, getTestActorId())
		const coding = await seedTask(workspaceId, getTestActorId())
		await db.insert(workTaskExtras).values([
			{ objectId: decision.id, workspaceId, decisionType: 'architecture' },
			{ objectId: coding.id, workspaceId },
		])
		const rows = await db
			.select({ id: workTaskExtras.objectId })
			.from(workTaskExtras)
			.where(and(eq(workTaskExtras.workspaceId, workspaceId), isNull(workTaskExtras.decisionType)))
		expect(rows.map((r) => r.id)).toEqual([coding.id])
	})

	// ── Backfill (idempotent replay) ──────────────────────────────────────────

	it('backfill promotes metadata.* into first-class columns for existing tasks', async () => {
		const validBetId = '33333333-3333-3333-3333-333333333333'
		const clean = await seedTask(workspaceId, getTestActorId(), {
			metadata: {
				decision_type: 'ux',
				explore_phase: 'solution',
				explore_candidate: true,
				explore_bet_id: validBetId,
			},
		})
		const partial = await seedTask(workspaceId, getTestActorId(), {
			metadata: { decision_type: 'architecture' },
		})
		const outOfEnum = await seedTask(workspaceId, getTestActorId(), {
			metadata: {
				decision_type: 'infra', // out-of-enum → NULL
				explore_phase: 'hypothesis', // out-of-enum → NULL
				explore_candidate: 'maybe', // not true/false → NULL
				explore_bet_id: 'not-a-uuid', // not a uuid → NULL
			},
		})
		const empty = await seedTask(workspaceId, getTestActorId())

		// Non-task objects must not get an extras row.
		const bet = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			status: 'signal',
			metadata: { decision_type: 'ux' },
		})

		// Re-run only the INSERT SELECT half. ON CONFLICT DO NOTHING keeps this
		// idempotent against the initial (empty) backfill on the fresh schema.
		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "work_task_extras"')
		expect(insertStart).toBeGreaterThan(0)
		await sql.unsafe(migrationSql.slice(insertStart))

		const rows = await db
			.select()
			.from(workTaskExtras)
			.where(eq(workTaskExtras.workspaceId, workspaceId))
		const byId = new Map(rows.map((r) => [r.objectId, r]))

		expect(byId.get(clean.id)?.decisionType).toBe('ux')
		expect(byId.get(clean.id)?.explorePhase).toBe('solution')
		expect(byId.get(clean.id)?.exploreCandidate).toBe(true)
		expect(byId.get(clean.id)?.exploreBetId).toBe(validBetId)

		expect(byId.get(partial.id)?.decisionType).toBe('architecture')
		expect(byId.get(partial.id)?.explorePhase).toBeNull()
		expect(byId.get(partial.id)?.exploreCandidate).toBeNull()
		expect(byId.get(partial.id)?.exploreBetId).toBeNull()

		expect(byId.get(outOfEnum.id)?.decisionType).toBeNull()
		expect(byId.get(outOfEnum.id)?.explorePhase).toBeNull()
		expect(byId.get(outOfEnum.id)?.exploreCandidate).toBeNull()
		expect(byId.get(outOfEnum.id)?.exploreBetId).toBeNull()

		// Empty metadata → row exists with all NULLs.
		expect(byId.has(empty.id)).toBe(true)
		expect(byId.get(empty.id)?.decisionType).toBeNull()

		// Non-task types get no row.
		expect(byId.has(bet.id)).toBe(false)
	})

	it('backfill leaves objects.metadata byte-identical (COPY, not MOVE)', async () => {
		const metadata = {
			decision_type: 'ux',
			explore_phase: 'root_cause',
			explore_candidate: true,
			explore_bet_id: '44444444-4444-4444-4444-444444444444',
		}
		const t = await seedTask(workspaceId, getTestActorId(), { metadata })

		const [before] = await sql`SELECT metadata FROM objects WHERE id = ${t.id}`

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "work_task_extras"')
		await sql.unsafe(migrationSql.slice(insertStart))

		const [after] = await sql`SELECT metadata FROM objects WHERE id = ${t.id}`
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
				WHERE table_schema = 'public' AND table_name = 'work_task_extras'
				ORDER BY column_name
			`
			const constraints = await sql<Row[]>`
				SELECT conname, contype, pg_get_constraintdef(oid) AS def
				FROM pg_constraint
				WHERE conrelid = 'public.work_task_extras'::regclass
				ORDER BY conname
			`
			const indexes = await sql<Row[]>`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = 'public' AND tablename = 'work_task_extras'
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

		const [gone] = await sql`SELECT to_regclass('public.work_task_extras') AS oid`
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
