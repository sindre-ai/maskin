import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crmCustomerExtras } from '@maskin/ext-crm/db-schema'
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
	'0048_crm_customer_extras.sql',
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
	'0048_crm_customer_extras.sql',
)

async function seedCustomer(
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	return insertObject(db, workspaceId, actorId, {
		type: 'customer',
		status: 'active',
		...overrides,
	})
}

describe('crm_customer_extras — migration + column filters + backfill', () => {
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
			WHERE c.conrelid = 'public.crm_customer_extras'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.crm_customer_extras'::regclass AND attname = 'object_id')
				]::int2[]
		`
		expect(row?.confdeltype, 'crm_customer_extras.object_id FK must be ON DELETE CASCADE').toBe('c')
	})

	it('deleting the parent object cascades the extras row', async () => {
		const c = await seedCustomer(workspaceId, getTestActorId())
		await db.insert(crmCustomerExtras).values({
			objectId: c.id,
			workspaceId,
			confidence: 'medium',
		})
		await sql`DELETE FROM objects WHERE id = ${c.id}`
		const [row] = await sql`SELECT * FROM crm_customer_extras WHERE object_id = ${c.id}`
		expect(row).toBeUndefined()
	})

	// Raw sql (postgres.js) is used for these CHECK assertions so the underlying
	// PostgresError surfaces directly. Drizzle wraps failed inserts in a
	// DrizzleQueryError whose `.message` is only `Failed query: <sql>\nparams: ...`
	// — the original constraint name lives on `.cause`, which `.rejects.toThrow`
	// does not walk. Raw sql skips that wrapper.

	it('enforces CHECK on confidence enum', async () => {
		const c = await seedCustomer(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO crm_customer_extras (object_id, workspace_id, confidence)
				VALUES (${c.id}, ${workspaceId}, 'certain')
			`,
		).rejects.toThrow(/crm_customer_extras_confidence_ck/)
	})

	it('enforces CHECK: evidence_count must be non-negative', async () => {
		const c = await seedCustomer(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO crm_customer_extras (object_id, workspace_id, evidence_count)
				VALUES (${c.id}, ${workspaceId}, -1)
			`,
		).rejects.toThrow(/crm_customer_extras_evidence_count_nonneg_ck/)
	})

	it('accepts NULLs on every promoted column', async () => {
		const c = await seedCustomer(workspaceId, getTestActorId())
		await db.insert(crmCustomerExtras).values({ objectId: c.id, workspaceId })
		const [row] = await db
			.select()
			.from(crmCustomerExtras)
			.where(eq(crmCustomerExtras.objectId, c.id))
		expect(row?.segment).toBeNull()
		expect(row?.confidence).toBeNull()
		expect(row?.lastValidated).toBeNull()
		expect(row?.evidenceCount).toBeNull()
	})

	// ── Column filters ────────────────────────────────────────────────────────

	it('filters by segment', async () => {
		const smb = await seedCustomer(workspaceId, getTestActorId())
		const enterprise = await seedCustomer(workspaceId, getTestActorId())
		await db.insert(crmCustomerExtras).values([
			{ objectId: smb.id, workspaceId, segment: 'smb' },
			{ objectId: enterprise.id, workspaceId, segment: 'enterprise' },
		])
		const rows = await db
			.select({ id: crmCustomerExtras.objectId })
			.from(crmCustomerExtras)
			.where(
				and(
					eq(crmCustomerExtras.workspaceId, workspaceId),
					eq(crmCustomerExtras.segment, 'enterprise'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([enterprise.id])
	})

	it('filters by confidence', async () => {
		const low = await seedCustomer(workspaceId, getTestActorId())
		const high = await seedCustomer(workspaceId, getTestActorId())
		await db.insert(crmCustomerExtras).values([
			{ objectId: low.id, workspaceId, confidence: 'low' },
			{ objectId: high.id, workspaceId, confidence: 'high' },
		])
		const rows = await db
			.select({ id: crmCustomerExtras.objectId })
			.from(crmCustomerExtras)
			.where(
				and(
					eq(crmCustomerExtras.workspaceId, workspaceId),
					eq(crmCustomerExtras.confidence, 'high'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([high.id])
	})

	it('filters by evidence_count', async () => {
		const few = await seedCustomer(workspaceId, getTestActorId())
		const many = await seedCustomer(workspaceId, getTestActorId())
		await db.insert(crmCustomerExtras).values([
			{ objectId: few.id, workspaceId, evidenceCount: 1 },
			{ objectId: many.id, workspaceId, evidenceCount: 12 },
		])
		const rows = await db
			.select({ id: crmCustomerExtras.objectId })
			.from(crmCustomerExtras)
			.where(
				and(
					eq(crmCustomerExtras.workspaceId, workspaceId),
					eq(crmCustomerExtras.evidenceCount, 12),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([many.id])
	})

	it('filters by last_validated IS NULL — customers missing a recent check', async () => {
		const validated = await seedCustomer(workspaceId, getTestActorId())
		const stale = await seedCustomer(workspaceId, getTestActorId())
		await db.insert(crmCustomerExtras).values([
			{ objectId: validated.id, workspaceId, lastValidated: '2026-06-01' },
			{ objectId: stale.id, workspaceId },
		])
		const rows = await db
			.select({ id: crmCustomerExtras.objectId })
			.from(crmCustomerExtras)
			.where(
				and(
					eq(crmCustomerExtras.workspaceId, workspaceId),
					isNull(crmCustomerExtras.lastValidated),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([stale.id])
	})

	// ── Backfill (idempotent replay) ──────────────────────────────────────────

	it('backfill promotes metadata.* into first-class columns for existing customers', async () => {
		const clean = await seedCustomer(workspaceId, getTestActorId(), {
			metadata: {
				segment: 'enterprise',
				confidence: 'high',
				last_validated: '2026-06-15',
				evidence_count: 8,
			},
		})
		const partial = await seedCustomer(workspaceId, getTestActorId(), {
			metadata: { segment: 'smb' },
		})
		const outOfShape = await seedCustomer(workspaceId, getTestActorId(), {
			metadata: {
				confidence: 'certain', // out-of-enum → NULL
				last_validated: 'sometime', // not a date → NULL
				evidence_count: 'many', // not an integer → NULL
				segment: '', // empty string → NULL
			},
		})
		const empty = await seedCustomer(workspaceId, getTestActorId())

		// Non-customer objects must not get an extras row.
		const contact = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'contact',
			status: 'new_lead',
			metadata: { segment: 'enterprise' },
		})

		// Re-run only the INSERT SELECT half. ON CONFLICT DO NOTHING keeps this
		// idempotent against the initial (empty) backfill on the fresh schema.
		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "crm_customer_extras"')
		expect(insertStart).toBeGreaterThan(0)
		await sql.unsafe(migrationSql.slice(insertStart))

		const rows = await db
			.select()
			.from(crmCustomerExtras)
			.where(eq(crmCustomerExtras.workspaceId, workspaceId))
		const byId = new Map(rows.map((r) => [r.objectId, r]))

		expect(byId.get(clean.id)?.segment).toBe('enterprise')
		expect(byId.get(clean.id)?.confidence).toBe('high')
		expect(byId.get(clean.id)?.lastValidated).toBe('2026-06-15')
		expect(byId.get(clean.id)?.evidenceCount).toBe(8)

		expect(byId.get(partial.id)?.segment).toBe('smb')
		expect(byId.get(partial.id)?.confidence).toBeNull()

		expect(byId.get(outOfShape.id)?.segment).toBeNull() // empty → NULL
		expect(byId.get(outOfShape.id)?.confidence).toBeNull()
		expect(byId.get(outOfShape.id)?.lastValidated).toBeNull()
		expect(byId.get(outOfShape.id)?.evidenceCount).toBeNull()

		// Empty metadata → row exists with all NULLs.
		expect(byId.has(empty.id)).toBe(true)
		expect(byId.get(empty.id)?.segment).toBeNull()

		// Non-customer types get no row.
		expect(byId.has(contact.id)).toBe(false)
	})

	it('backfill leaves objects.metadata byte-identical (COPY, not MOVE)', async () => {
		const metadata = {
			segment: 'enterprise',
			confidence: 'high',
			last_validated: '2026-06-15',
			evidence_count: 8,
		}
		const c = await seedCustomer(workspaceId, getTestActorId(), { metadata })

		const [before] = await sql`SELECT metadata FROM objects WHERE id = ${c.id}`

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "crm_customer_extras"')
		await sql.unsafe(migrationSql.slice(insertStart))

		const [after] = await sql`SELECT metadata FROM objects WHERE id = ${c.id}`
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
				WHERE table_schema = 'public' AND table_name = 'crm_customer_extras'
				ORDER BY column_name
			`
			const constraints = await sql<Row[]>`
				SELECT conname, contype, pg_get_constraintdef(oid) AS def
				FROM pg_constraint
				WHERE conrelid = 'public.crm_customer_extras'::regclass
				ORDER BY conname
			`
			const indexes = await sql<Row[]>`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = 'public' AND tablename = 'crm_customer_extras'
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

		const [gone] = await sql`SELECT to_regclass('public.crm_customer_extras') AS oid`
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
