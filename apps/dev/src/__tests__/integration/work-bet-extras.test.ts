import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workBetExtras } from '@maskin/ext-work/db-schema'
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
	'0047_work_bet_extras.sql',
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
	'0047_work_bet_extras.sql',
)

async function seedBet(workspaceId: string, actorId: string, overrides?: Record<string, unknown>) {
	return insertObject(db, workspaceId, actorId, {
		type: 'bet',
		status: 'signal',
		...overrides,
	})
}

describe('work_bet_extras — migration + column filters + backfill', () => {
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
			WHERE c.conrelid = 'public.work_bet_extras'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.work_bet_extras'::regclass AND attname = 'object_id')
				]::int2[]
		`
		expect(row?.confdeltype, 'work_bet_extras.object_id FK must be ON DELETE CASCADE').toBe('c')
	})

	it('deleting the parent object cascades the extras row', async () => {
		const b = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values({
			objectId: b.id,
			workspaceId,
			promotionMode: 'auto',
		})
		await sql`DELETE FROM objects WHERE id = ${b.id}`
		const [row] = await sql`SELECT * FROM work_bet_extras WHERE object_id = ${b.id}`
		expect(row).toBeUndefined()
	})

	// Raw sql (postgres.js) is used for these CHECK assertions so the underlying
	// PostgresError surfaces directly. Drizzle wraps failed inserts in a
	// DrizzleQueryError whose `.message` is only `Failed query: <sql>\nparams: ...`
	// — the original constraint name lives on `.cause`, which `.rejects.toThrow`
	// does not walk. Raw sql skips that wrapper.

	it('enforces CHECK on promotion_mode enum', async () => {
		const b = await seedBet(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_bet_extras (object_id, workspace_id, promotion_mode)
				VALUES (${b.id}, ${workspaceId}, 'shipped')
			`,
		).rejects.toThrow(/work_bet_extras_promotion_mode_ck/)
	})

	it('enforces CHECK on evidence_quality enum', async () => {
		const b = await seedBet(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_bet_extras (object_id, workspace_id, evidence_quality)
				VALUES (${b.id}, ${workspaceId}, 'anecdote')
			`,
		).rejects.toThrow(/work_bet_extras_evidence_quality_ck/)
	})

	it('enforces CHECK on feedback_source enum', async () => {
		const b = await seedBet(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO work_bet_extras (object_id, workspace_id, feedback_source)
				VALUES (${b.id}, ${workspaceId}, 'twitter')
			`,
		).rejects.toThrow(/work_bet_extras_feedback_source_ck/)
	})

	it('accepts NULLs on every promoted column', async () => {
		const b = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values({ objectId: b.id, workspaceId })
		const [row] = await db.select().from(workBetExtras).where(eq(workBetExtras.objectId, b.id))
		expect(row?.promotionMode).toBeNull()
		expect(row?.reviewDate).toBeNull()
		expect(row?.evidenceQuality).toBeNull()
		expect(row?.feedbackSource).toBeNull()
		expect(row?.mergeBlocked).toBeNull()
		expect(row?.mergeBlockedSince).toBeNull()
	})

	// ── Column filters ────────────────────────────────────────────────────────

	it('filters by promotion_mode', async () => {
		const auto = await seedBet(workspaceId, getTestActorId())
		const human = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values([
			{ objectId: auto.id, workspaceId, promotionMode: 'auto' },
			{ objectId: human.id, workspaceId, promotionMode: 'human_approved' },
		])
		const rows = await db
			.select({ id: workBetExtras.objectId })
			.from(workBetExtras)
			.where(
				and(
					eq(workBetExtras.workspaceId, workspaceId),
					eq(workBetExtras.promotionMode, 'human_approved'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([human.id])
	})

	it('filters by evidence_quality', async () => {
		const gut = await seedBet(workspaceId, getTestActorId())
		const evidence = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values([
			{ objectId: gut.id, workspaceId, evidenceQuality: 'gut_feeling' },
			{ objectId: evidence.id, workspaceId, evidenceQuality: 'evidence_backed' },
		])
		const rows = await db
			.select({ id: workBetExtras.objectId })
			.from(workBetExtras)
			.where(
				and(
					eq(workBetExtras.workspaceId, workspaceId),
					eq(workBetExtras.evidenceQuality, 'evidence_backed'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([evidence.id])
	})

	it('filters by feedback_source', async () => {
		const slack = await seedBet(workspaceId, getTestActorId())
		const email = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values([
			{ objectId: slack.id, workspaceId, feedbackSource: 'slack' },
			{ objectId: email.id, workspaceId, feedbackSource: 'email' },
		])
		const rows = await db
			.select({ id: workBetExtras.objectId })
			.from(workBetExtras)
			.where(
				and(eq(workBetExtras.workspaceId, workspaceId), eq(workBetExtras.feedbackSource, 'slack')),
			)
		expect(rows.map((r) => r.id)).toEqual([slack.id])
	})

	it('filters by merge_blocked = true', async () => {
		const blocked = await seedBet(workspaceId, getTestActorId())
		const clear = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values([
			{ objectId: blocked.id, workspaceId, mergeBlocked: true },
			{ objectId: clear.id, workspaceId, mergeBlocked: false },
		])
		const rows = await db
			.select({ id: workBetExtras.objectId })
			.from(workBetExtras)
			.where(and(eq(workBetExtras.workspaceId, workspaceId), eq(workBetExtras.mergeBlocked, true)))
		expect(rows.map((r) => r.id)).toEqual([blocked.id])
	})

	it('filters by review_date IS NULL — bets missing a review cadence', async () => {
		const scheduled = await seedBet(workspaceId, getTestActorId())
		const unscheduled = await seedBet(workspaceId, getTestActorId())
		await db.insert(workBetExtras).values([
			{ objectId: scheduled.id, workspaceId, reviewDate: '2026-08-01' },
			{ objectId: unscheduled.id, workspaceId },
		])
		const rows = await db
			.select({ id: workBetExtras.objectId })
			.from(workBetExtras)
			.where(and(eq(workBetExtras.workspaceId, workspaceId), isNull(workBetExtras.reviewDate)))
		expect(rows.map((r) => r.id)).toEqual([unscheduled.id])
	})

	// ── Backfill (idempotent replay) ──────────────────────────────────────────

	it('backfill promotes metadata.* into first-class columns for existing bets', async () => {
		const clean = await seedBet(workspaceId, getTestActorId(), {
			metadata: {
				promotion_mode: 'human_approved',
				review_date: '2026-08-15',
				evidence_quality: 'evidence_backed',
				feedback_source: 'slack',
				merge_blocked: true,
				merge_blocked_since: '2026-07-01',
			},
		})
		const partial = await seedBet(workspaceId, getTestActorId(), {
			metadata: { promotion_mode: 'auto' },
		})
		const outOfEnum = await seedBet(workspaceId, getTestActorId(), {
			metadata: {
				promotion_mode: 'shipped', // out-of-enum → NULL
				evidence_quality: 'anecdote', // out-of-enum → NULL
				feedback_source: 'twitter', // out-of-enum → 'other'
				merge_blocked: 'maybe', // not true/false → NULL
				review_date: 'sometime', // not a date → NULL
			},
		})
		const empty = await seedBet(workspaceId, getTestActorId())

		// Non-bet objects must not get an extras row.
		const insight = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'insight',
			status: 'new',
			metadata: { promotion_mode: 'auto' },
		})

		// Re-run only the INSERT SELECT half. ON CONFLICT DO NOTHING keeps this
		// idempotent against the initial (empty) backfill on the fresh schema.
		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "work_bet_extras"')
		expect(insertStart).toBeGreaterThan(0)
		await sql.unsafe(migrationSql.slice(insertStart))

		const rows = await db
			.select()
			.from(workBetExtras)
			.where(eq(workBetExtras.workspaceId, workspaceId))
		const byId = new Map(rows.map((r) => [r.objectId, r]))

		expect(byId.get(clean.id)?.promotionMode).toBe('human_approved')
		expect(byId.get(clean.id)?.reviewDate).toBe('2026-08-15')
		expect(byId.get(clean.id)?.evidenceQuality).toBe('evidence_backed')
		expect(byId.get(clean.id)?.feedbackSource).toBe('slack')
		expect(byId.get(clean.id)?.mergeBlocked).toBe(true)
		expect(byId.get(clean.id)?.mergeBlockedSince).toBe('2026-07-01')

		expect(byId.get(partial.id)?.promotionMode).toBe('auto')
		expect(byId.get(partial.id)?.reviewDate).toBeNull()

		expect(byId.get(outOfEnum.id)?.promotionMode).toBeNull()
		expect(byId.get(outOfEnum.id)?.evidenceQuality).toBeNull()
		expect(byId.get(outOfEnum.id)?.feedbackSource).toBe('other') // coalesced
		expect(byId.get(outOfEnum.id)?.mergeBlocked).toBeNull()
		expect(byId.get(outOfEnum.id)?.reviewDate).toBeNull()

		// Empty metadata → row exists with all NULLs.
		expect(byId.has(empty.id)).toBe(true)
		expect(byId.get(empty.id)?.promotionMode).toBeNull()

		// Non-bet types get no row.
		expect(byId.has(insight.id)).toBe(false)
	})

	it('backfill leaves objects.metadata byte-identical (COPY, not MOVE)', async () => {
		const metadata = {
			promotion_mode: 'human_approved',
			evidence_quality: 'evidence_backed',
			feedback_source: 'slack',
			merge_blocked: true,
		}
		const b = await seedBet(workspaceId, getTestActorId(), { metadata })

		const [before] = await sql`SELECT metadata FROM objects WHERE id = ${b.id}`

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "work_bet_extras"')
		await sql.unsafe(migrationSql.slice(insertStart))

		const [after] = await sql`SELECT metadata FROM objects WHERE id = ${b.id}`
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
				WHERE table_schema = 'public' AND table_name = 'work_bet_extras'
				ORDER BY column_name
			`
			const constraints = await sql<Row[]>`
				SELECT conname, contype, pg_get_constraintdef(oid) AS def
				FROM pg_constraint
				WHERE conrelid = 'public.work_bet_extras'::regclass
				ORDER BY conname
			`
			const indexes = await sql<Row[]>`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = 'public' AND tablename = 'work_bet_extras'
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

		const [gone] = await sql`SELECT to_regclass('public.work_bet_extras') AS oid`
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
