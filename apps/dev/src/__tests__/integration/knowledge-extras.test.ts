import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { knowledgeExtras } from '@maskin/ext-knowledge/db-schema'
import { and, eq, isNull } from 'drizzle-orm'
import { buildCreateRelationshipBody, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: relationshipsRoutes } = await import('../../routes/relationships')

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
	'0047_knowledge_extras.sql',
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
	'0047_knowledge_extras.sql',
)

function createApp() {
	return createIntegrationApp({ path: '/api/relationships', module: relationshipsRoutes })
}

async function seedKnowledge(
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	return insertObject(db, workspaceId, actorId, {
		type: 'knowledge',
		status: 'draft',
		...overrides,
	})
}

describe('knowledge_extras — migration + column filters + supersede semantics', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	// ── Schema shape (AC1 foundation) ──────────────────────────────────────────

	it('table exists with FK CASCADE on object_id', async () => {
		const [row] = await sql`
			SELECT c.confdeltype
			FROM pg_constraint c
			WHERE c.conrelid = 'public.knowledge_extras'::regclass
				AND c.contype = 'f'
				AND c.conkey = ARRAY[
					(SELECT attnum FROM pg_attribute
					 WHERE attrelid = 'public.knowledge_extras'::regclass AND attname = 'object_id')
				]::int2[]
		`
		// 'c' = CASCADE
		expect(row?.confdeltype, 'knowledge_extras.object_id FK must be ON DELETE CASCADE').toBe('c')
	})

	it('deleting the parent object cascades the extras row', async () => {
		const k = await seedKnowledge(workspaceId, getTestActorId())
		await db.insert(knowledgeExtras).values({
			objectId: k.id,
			workspaceId,
			writerType: 'human',
			provenanceType: 'insight',
		})
		await sql`DELETE FROM objects WHERE id = ${k.id}`
		const [row] = await sql`SELECT * FROM knowledge_extras WHERE object_id = ${k.id}`
		expect(row).toBeUndefined()
	})

	// Raw sql (postgres.js) is used for these CHECK assertions so the underlying
	// PostgresError surfaces directly. Drizzle wraps failed inserts in a
	// DrizzleQueryError whose `.message` is only `Failed query: <sql>\nparams: ...`
	// — the original constraint name lives on `.cause`, which `.rejects.toThrow`
	// does not walk. Raw sql skips that wrapper.

	it('enforces CHECK on confidence enum', async () => {
		const k = await seedKnowledge(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO knowledge_extras
					(object_id, workspace_id, writer_type, provenance_type, confidence)
				VALUES (${k.id}, ${workspaceId}, 'human', 'insight', 'certain')
			`,
		).rejects.toThrow(/knowledge_extras_confidence_ck/)
	})

	it('enforces CHECK on verification_status enum', async () => {
		const k = await seedKnowledge(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO knowledge_extras
					(object_id, workspace_id, writer_type, provenance_type, verification_status)
				VALUES (${k.id}, ${workspaceId}, 'human', 'insight', 'bogus')
			`,
		).rejects.toThrow(/knowledge_extras_verification_status_ck/)
	})

	it('enforces CHECK on writer_type enum', async () => {
		const k = await seedKnowledge(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO knowledge_extras
					(object_id, workspace_id, writer_type, provenance_type)
				VALUES (${k.id}, ${workspaceId}, 'bot', 'insight')
			`,
		).rejects.toThrow(/knowledge_extras_writer_type_ck/)
	})

	it('enforces CHECK on provenance_type enum', async () => {
		const k = await seedKnowledge(workspaceId, getTestActorId())
		await expect(
			sql`
				INSERT INTO knowledge_extras
					(object_id, workspace_id, writer_type, provenance_type)
				VALUES (${k.id}, ${workspaceId}, 'human', 'twitter')
			`,
		).rejects.toThrow(/knowledge_extras_provenance_type_ck/)
	})

	// ── Column filters (AC1) ───────────────────────────────────────────────────

	it('filters by t_invalid IS NULL — live rows only', async () => {
		const live = await seedKnowledge(workspaceId, getTestActorId())
		const invalid = await seedKnowledge(workspaceId, getTestActorId())
		await db.insert(knowledgeExtras).values([
			{ objectId: live.id, workspaceId, writerType: 'human', provenanceType: 'insight' },
			{
				objectId: invalid.id,
				workspaceId,
				writerType: 'human',
				provenanceType: 'insight',
				tInvalid: new Date(),
			},
		])
		const rows = await db
			.select({ id: knowledgeExtras.objectId })
			.from(knowledgeExtras)
			.where(and(eq(knowledgeExtras.workspaceId, workspaceId), isNull(knowledgeExtras.tInvalid)))
		expect(rows.map((r) => r.id)).toEqual([live.id])
	})

	it('filters by confidence', async () => {
		const high = await seedKnowledge(workspaceId, getTestActorId())
		const low = await seedKnowledge(workspaceId, getTestActorId())
		await db.insert(knowledgeExtras).values([
			{
				objectId: high.id,
				workspaceId,
				writerType: 'human',
				provenanceType: 'insight',
				confidence: 'high',
			},
			{
				objectId: low.id,
				workspaceId,
				writerType: 'human',
				provenanceType: 'insight',
				confidence: 'low',
			},
		])
		const rows = await db
			.select({ id: knowledgeExtras.objectId })
			.from(knowledgeExtras)
			.where(
				and(eq(knowledgeExtras.workspaceId, workspaceId), eq(knowledgeExtras.confidence, 'high')),
			)
		expect(rows.map((r) => r.id)).toEqual([high.id])
	})

	it('filters by verification_status', async () => {
		const verified = await seedKnowledge(workspaceId, getTestActorId())
		const pending = await seedKnowledge(workspaceId, getTestActorId())
		await db.insert(knowledgeExtras).values([
			{
				objectId: verified.id,
				workspaceId,
				writerType: 'human',
				provenanceType: 'insight',
				verificationStatus: 'verified',
			},
			{
				objectId: pending.id,
				workspaceId,
				writerType: 'human',
				provenanceType: 'insight',
				verificationStatus: 'pending',
			},
		])
		const rows = await db
			.select({ id: knowledgeExtras.objectId })
			.from(knowledgeExtras)
			.where(
				and(
					eq(knowledgeExtras.workspaceId, workspaceId),
					eq(knowledgeExtras.verificationStatus, 'verified'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([verified.id])
	})

	it('filters by writer_type', async () => {
		const human = await seedKnowledge(workspaceId, getTestActorId())
		const agent = await seedKnowledge(workspaceId, getTestActorId())
		await db.insert(knowledgeExtras).values([
			{ objectId: human.id, workspaceId, writerType: 'human', provenanceType: 'insight' },
			{ objectId: agent.id, workspaceId, writerType: 'agent', provenanceType: 'agent-write' },
		])
		const rows = await db
			.select({ id: knowledgeExtras.objectId })
			.from(knowledgeExtras)
			.where(
				and(eq(knowledgeExtras.workspaceId, workspaceId), eq(knowledgeExtras.writerType, 'human')),
			)
		expect(rows.map((r) => r.id)).toEqual([human.id])
	})

	it('filters by provenance_type', async () => {
		const slack = await seedKnowledge(workspaceId, getTestActorId())
		const meeting = await seedKnowledge(workspaceId, getTestActorId())
		await db.insert(knowledgeExtras).values([
			{ objectId: slack.id, workspaceId, writerType: 'human', provenanceType: 'slack' },
			{ objectId: meeting.id, workspaceId, writerType: 'human', provenanceType: 'meeting' },
		])
		const rows = await db
			.select({ id: knowledgeExtras.objectId })
			.from(knowledgeExtras)
			.where(
				and(
					eq(knowledgeExtras.workspaceId, workspaceId),
					eq(knowledgeExtras.provenanceType, 'slack'),
				),
			)
		expect(rows.map((r) => r.id)).toEqual([slack.id])
	})

	// ── Backfill (idempotent replay) ───────────────────────────────────────────

	it('backfill maps status=validated → verified, status=deprecated → t_invalid=now(), source_type → provenance_type', async () => {
		const validated = await seedKnowledge(workspaceId, getTestActorId(), {
			status: 'validated',
			metadata: { source_type: 'meeting', confidence: 'high' },
		})
		const deprecated = await seedKnowledge(workspaceId, getTestActorId(), {
			status: 'deprecated',
			metadata: { source_type: 'slack' },
		})
		const draft = await seedKnowledge(workspaceId, getTestActorId(), {
			metadata: { confidence: 'unknown' },
		})

		// Re-run only the INSERT SELECT half of the migration. ON CONFLICT DO NOTHING
		// keeps this idempotent against the initial (empty) backfill.
		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "knowledge_extras"')
		expect(insertStart).toBeGreaterThan(0)
		await sql.unsafe(migrationSql.slice(insertStart))

		const rows = await db
			.select()
			.from(knowledgeExtras)
			.where(eq(knowledgeExtras.workspaceId, workspaceId))
		const byId = new Map(rows.map((r) => [r.objectId, r]))
		expect(byId.get(validated.id)?.verificationStatus).toBe('verified')
		expect(byId.get(validated.id)?.provenanceType).toBe('meeting')
		expect(byId.get(validated.id)?.confidence).toBe('high')
		expect(byId.get(deprecated.id)?.tInvalid).not.toBeNull()
		expect(byId.get(deprecated.id)?.provenanceType).toBe('slack')
		expect(byId.get(draft.id)?.verificationStatus).toBe('unverified')
		expect(byId.get(draft.id)?.provenanceType).toBe('imported') // COALESCE default
		expect(byId.get(draft.id)?.confidence).toBeNull() // out-of-enum → NULL
		expect(byId.get(draft.id)?.writerType).toBe('human') // integration actor is human
	})

	it('backfill maps workspace-renamed knowledge statuses by position, not the hardcoded English labels', async () => {
		// This workspace renamed the default ['draft','validated','deprecated']
		// labels to ['draft','confirmed','retired'] but kept the same positions —
		// the backfill must read the workspace's own settings.statuses.knowledge
		// array rather than assuming the literal strings 'validated'/'deprecated'.
		const renamedWs = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['knowledge'],
				statuses: { knowledge: ['draft', 'confirmed', 'retired'] },
			},
		})
		const confirmed = await seedKnowledge(renamedWs.id, getTestActorId(), { status: 'confirmed' })
		const retired = await seedKnowledge(renamedWs.id, getTestActorId(), { status: 'retired' })
		const draft = await seedKnowledge(renamedWs.id, getTestActorId(), { status: 'draft' })

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		const insertStart = migrationSql.indexOf('INSERT INTO "knowledge_extras"')
		expect(insertStart).toBeGreaterThan(0)
		await sql.unsafe(migrationSql.slice(insertStart))

		const rows = await db
			.select()
			.from(knowledgeExtras)
			.where(eq(knowledgeExtras.workspaceId, renamedWs.id))
		const byId = new Map(rows.map((r) => [r.objectId, r]))
		expect(byId.get(confirmed.id)?.verificationStatus).toBe('verified')
		expect(byId.get(retired.id)?.tInvalid).not.toBeNull()
		expect(byId.get(draft.id)?.verificationStatus).toBe('unverified')
		expect(byId.get(draft.id)?.tInvalid).toBeNull()
	})

	// ── Bi-temporal write path (AC4) ───────────────────────────────────────────

	it('creating a supersedes edge between two knowledge objects stamps t_invalid on the target', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId())
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)

		const [row] = await db
			.select()
			.from(knowledgeExtras)
			.where(eq(knowledgeExtras.objectId, oldKnowledge.id))
		expect(row).toBeDefined()
		expect(row?.tInvalid).not.toBeNull()

		// AC4: the row itself must still exist (not deleted).
		const [obj] = await sql`SELECT id FROM objects WHERE id = ${oldKnowledge.id}`
		expect(obj?.id).toBe(oldKnowledge.id)
	})

	it('creating a contradicts edge stamps t_invalid on the target', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId())
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'contradicts',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)

		const [row] = await db
			.select()
			.from(knowledgeExtras)
			.where(eq(knowledgeExtras.objectId, oldKnowledge.id))
		expect(row?.tInvalid).not.toBeNull()
	})

	it('non-knowledge supersede edge does NOT touch knowledge_extras', async () => {
		const app = createApp()
		const insight = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'insight',
			status: 'new',
		})
		const bet = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			status: 'signal',
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'bet',
					source_id: bet.id,
					target_type: 'insight',
					target_id: insight.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)

		const rows = await db.select().from(knowledgeExtras).where(eq(knowledgeExtras.objectId, bet.id))
		expect(rows).toHaveLength(0)
	})

	it('supersede is idempotent — re-stamping preserves the extras row and updates t_invalid', async () => {
		const app = createApp()
		const oldKnowledge = await seedKnowledge(workspaceId, getTestActorId())
		const newKnowledge = await seedKnowledge(workspaceId, getTestActorId())

		// Pre-seed a live extras row so we exercise the ON CONFLICT branch.
		await db.insert(knowledgeExtras).values({
			objectId: oldKnowledge.id,
			workspaceId,
			writerType: 'human',
			provenanceType: 'insight',
			confidence: 'high',
			verificationStatus: 'verified',
		})

		await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_type: 'knowledge',
					source_id: newKnowledge.id,
					target_type: 'knowledge',
					target_id: oldKnowledge.id,
					type: 'supersedes',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		const [row] = await db
			.select()
			.from(knowledgeExtras)
			.where(eq(knowledgeExtras.objectId, oldKnowledge.id))
		expect(row?.tInvalid).not.toBeNull()
		// Pre-existing fields must NOT be clobbered.
		expect(row?.confidence).toBe('high')
		expect(row?.verificationStatus).toBe('verified')
	})

	// ── Reversibility (AC5) ────────────────────────────────────────────────────

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
				WHERE table_schema = 'public' AND table_name = 'knowledge_extras'
				ORDER BY column_name
			`
			const constraints = await sql<Row[]>`
				SELECT conname, contype, pg_get_constraintdef(oid) AS def
				FROM pg_constraint
				WHERE conrelid = 'public.knowledge_extras'::regclass
				ORDER BY conname
			`
			const indexes = await sql<Row[]>`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = 'public' AND tablename = 'knowledge_extras'
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

		const [gone] = await sql`
			SELECT to_regclass('public.knowledge_extras') AS oid
		`
		expect(gone?.oid).toBeNull()

		const migrationSql = readFileSync(migrationPath, 'utf-8')
		await sql.unsafe(migrationSql)

		const after = await snapshot()

		// Split into three assertions so a failure narrows to columns vs
		// constraints vs indexes rather than dumping the full diff.
		expect(after.cols, 'columns diverged after up → down → up').toEqual(before.cols)
		expect(after.constraints, 'constraints diverged after up → down → up').toEqual(
			before.constraints,
		)
		expect(after.indexes, 'indexes diverged after up → down → up').toEqual(before.indexes)
	})
})
