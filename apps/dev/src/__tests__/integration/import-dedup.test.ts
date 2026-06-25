import { importAuditRows, imports, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type { WorkspaceSettings } from '../../lib/types'
import { executeImport } from '../../services/import-processor'
import { buildImport, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// AC-T2/T3/T4/T6/T7 acceptance — exercises the dedup matching engine, the
// per-column diff, and the audit writes against a real Postgres so the
// JSONB path + NULL semantics + per-batch transaction atomicity are all in
// scope (mocked unit tests cannot prove any of this).

const SETTINGS: WorkspaceSettings = {
	display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
	statuses: {
		insight: ['new', 'processing', 'clustered', 'discarded'],
		bet: ['signal', 'proposed', 'active', 'completed', 'succeeded', 'failed', 'paused'],
		task: ['todo', 'in_progress', 'done'],
	},
	field_definitions: {},
	relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates'],
	custom_extensions: {},
	enabled_modules: ['work'],
	max_concurrent_sessions: 5,
	llm_keys: {},
}

async function setupImportFixture() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const [importRow] = await db
		.insert(imports)
		.values(
			buildImport({
				workspaceId: ws.id,
				createdBy: actorId,
				status: 'importing',
			}),
		)
		.returning()
	if (!importRow) throw new Error('failed to create import fixture')
	return { workspaceId: ws.id, actorId, importId: importRow.id }
}

async function fetchImport(importId: string) {
	const [row] = await db.select().from(imports).where(eq(imports.id, importId))
	return row
}

async function fetchAuditForImport(importId: string) {
	return db
		.select()
		.from(importAuditRows)
		.where(eq(importAuditRows.importId, importId))
		.orderBy(importAuditRows.rowIndex)
}

describe('Import dedup engine — integration', () => {
	it('AC-T2: two dedup keys are AND-composed across both fields (never OR)', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		await db.insert(objects).values([
			{
				workspaceId,
				type: 'task',
				title: 'Alice',
				status: 'todo',
				metadata: { email: 'shared@example.com' },
				createdBy: actorId,
			},
			{
				workspaceId,
				type: 'task',
				title: 'Bob',
				status: 'todo',
				metadata: { email: 'shared@example.com' },
				createdBy: actorId,
			},
		])

		const result = await executeImport(
			importId,
			[{ name: 'Alice', email: 'other@example.com' }],
			{
				typeMappings: [
					{
						objectType: 'task',
						defaultStatus: 'todo',
						dedupKeys: ['title', 'metadata.email'],
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
							{
								sourceColumn: 'email',
								targetField: 'metadata.email',
								transform: 'none',
								skip: false,
							},
						],
					},
				],
				relationships: [],
			},
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(result.successCount).toBe(1)
		expect(result.updatedCount).toBe(0)
		expect(result.skippedCount).toBe(0)

		const aliceRows = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.title, 'Alice')))
		expect(aliceRows).toHaveLength(2)

		const audit = await fetchAuditForImport(importId)
		expect(audit).toHaveLength(1)
		expect(audit[0]?.action).toBe('created')
	})

	it('AC-T3: empty/NULL dedup values never match (empty ≠ empty), CSV empty routes to create', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		await db.insert(objects).values({
			workspaceId,
			type: 'task',
			title: 'Has no email',
			status: 'todo',
			metadata: {},
			createdBy: actorId,
		})

		const result = await executeImport(
			importId,
			[
				{ name: 'Has no email', email: '' },
				{ name: '', email: '' },
			],
			{
				typeMappings: [
					{
						objectType: 'task',
						defaultStatus: 'todo',
						dedupKeys: ['title', 'metadata.email'],
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
							{
								sourceColumn: 'email',
								targetField: 'metadata.email',
								transform: 'none',
								skip: false,
							},
						],
					},
				],
				relationships: [],
			},
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(result.successCount).toBe(1)
		expect(result.updatedCount).toBe(0)
		expect(result.skippedCount).toBe(0)

		const allTasks = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'task')))
		expect(allTasks).toHaveLength(2)
	})

	it('AC-T4: matched rows update only changed columns; CSV-omitted columns stay untouched', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		const [stored] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'task',
				title: 'Refactor login',
				content: 'Old description',
				status: 'in_progress',
				metadata: { email: 'login@example.com', untouched: 'preserve-me' },
				createdBy: actorId,
			})
			.returning()
		if (!stored) throw new Error('seed insert failed')

		const result = await executeImport(
			importId,
			[{ name: 'Refactor login', email: 'login@example.com', description: 'Updated description' }],
			{
				typeMappings: [
					{
						objectType: 'task',
						defaultStatus: 'todo',
						dedupKeys: ['title', 'metadata.email'],
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
							{
								sourceColumn: 'email',
								targetField: 'metadata.email',
								transform: 'none',
								skip: false,
							},
							{
								sourceColumn: 'description',
								targetField: 'content',
								transform: 'none',
								skip: false,
							},
						],
					},
				],
				relationships: [],
			},
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(result.successCount).toBe(0)
		expect(result.updatedCount).toBe(1)
		expect(result.skippedCount).toBe(0)

		const [updated] = await db.select().from(objects).where(eq(objects.id, stored.id))
		expect(updated?.content).toBe('Updated description')
		expect(updated?.status).toBe('in_progress')
		expect((updated?.metadata as Record<string, unknown> | null)?.untouched).toBe('preserve-me')

		const audit = await fetchAuditForImport(importId)
		expect(audit).toHaveLength(1)
		expect(audit[0]?.action).toBe('updated')
		expect(audit[0]?.changedColumns).toEqual(['content'])
		expect(audit[0]?.oldValues).toEqual({ content: 'Old description' })
		expect(audit[0]?.newValues).toEqual({ content: 'Updated description' })
	})

	it('AC-T6: re-running the same CSV with the same dedup keys yields zero changes (idempotent)', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		const csv = [
			{ name: 'Refactor login', email: 'login@example.com', description: 'Initial' },
			{ name: 'Wire SSO', email: 'sso@example.com', description: 'Initial' },
		]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					defaultStatus: 'todo',
					dedupKeys: ['title', 'metadata.email'],
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
						{
							sourceColumn: 'email',
							targetField: 'metadata.email',
							transform: 'none' as const,
							skip: false,
						},
						{
							sourceColumn: 'description',
							targetField: 'content',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [],
		}

		const firstRun = await executeImport(importId, csv, mapping, workspaceId, actorId, SETTINGS, db)
		expect(firstRun.successCount).toBe(2)

		const [secondImport] = await db
			.insert(imports)
			.values(buildImport({ workspaceId, createdBy: actorId, status: 'importing' }))
			.returning()
		if (!secondImport) throw new Error('failed to create second import')
		const secondRun = await executeImport(
			secondImport.id,
			csv,
			mapping,
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(secondRun.successCount).toBe(0)
		expect(secondRun.updatedCount).toBe(0)
		expect(secondRun.skippedCount).toBe(2)

		const audit = await fetchAuditForImport(secondImport.id)
		expect(audit).toHaveLength(2)
		expect(audit.every((a) => a.action === 'skipped')).toBe(true)
	})

	it('AC-T7: per-batch transaction commits atomically — parallel imports do not double-create', async () => {
		const { workspaceId, actorId } = await setupImportFixture()

		const sharedCsv = [
			{ name: 'Hire eng manager', email: 'eng-mgr@example.com' },
			{ name: 'Hire designer', email: 'designer@example.com' },
		]
		const mapping = {
			typeMappings: [
				{
					objectType: 'task',
					defaultStatus: 'todo',
					dedupKeys: ['title', 'metadata.email'],
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none' as const, skip: false },
						{
							sourceColumn: 'email',
							targetField: 'metadata.email',
							transform: 'none' as const,
							skip: false,
						},
					],
				},
			],
			relationships: [],
		}

		const importA = await db
			.insert(imports)
			.values(buildImport({ workspaceId, createdBy: actorId, status: 'importing' }))
			.returning()
		const importB = await db
			.insert(imports)
			.values(buildImport({ workspaceId, createdBy: actorId, status: 'importing' }))
			.returning()
		const aId = importA[0]?.id
		const bId = importB[0]?.id
		if (!aId || !bId) throw new Error('failed to create import rows')

		const [resA, resB] = await Promise.all([
			executeImport(aId, sharedCsv, mapping, workspaceId, actorId, SETTINGS, db),
			executeImport(bId, sharedCsv, mapping, workspaceId, actorId, SETTINGS, db),
		])

		const stored = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'task')))
		const seenTuples = new Set<string>()
		for (const obj of stored) {
			const email = (obj.metadata as Record<string, unknown> | null)?.email
			seenTuples.add(`${obj.title ?? ''}\u0000${String(email ?? '')}`)
		}
		expect(stored.length).toBe(seenTuples.size)
		expect(seenTuples.size).toBe(2)
		expect(resA.successCount + resB.successCount).toBe(2)
	})

	it('matches existing objects by metadata.<field> JSONB path (cross-checks AC-T1 correctness)', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		const seed: {
			workspaceId: string
			type: string
			title: string
			status: string
			metadata: Record<string, unknown>
			createdBy: string
		}[] = []
		for (let n = 0; n < 50; n++) {
			seed.push({
				workspaceId,
				type: 'task',
				title: `Existing ${n}`,
				status: 'todo',
				metadata: { externalId: `ext-${n}` },
				createdBy: actorId,
			})
		}
		await db.insert(objects).values(seed)

		const result = await executeImport(
			importId,
			[
				{ name: 'New name for 10', externalId: 'ext-10' },
				{ name: 'New name for 25', externalId: 'ext-25' },
				{ name: 'Brand new', externalId: 'ext-9999' },
			],
			{
				typeMappings: [
					{
						objectType: 'task',
						defaultStatus: 'todo',
						dedupKeys: ['metadata.externalId'],
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
							{
								sourceColumn: 'externalId',
								targetField: 'metadata.externalId',
								transform: 'none',
								skip: false,
							},
						],
					},
				],
				relationships: [],
			},
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(result.successCount).toBe(1)
		expect(result.updatedCount).toBe(2)
		expect(result.skippedCount).toBe(0)

		const finalImport = await fetchImport(importId)
		expect(finalImport?.successCount).toBe(1)
		expect(finalImport?.updatedCount).toBe(2)
		expect(finalImport?.skippedCount).toBe(0)
	})

	// === NEW: regression for the per-row status provenance bug ===
	it('mapped Status column with empty row cell never overwrites the existing status', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		const [stored] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'task',
				title: 'Ship onboarding',
				status: 'in_progress',
				metadata: { email: 'lead@example.com' },
				createdBy: actorId,
			})
			.returning()
		if (!stored) throw new Error('seed insert failed')

		const result = await executeImport(
			importId,
			[{ name: 'Ship onboarding', email: 'lead@example.com', state: '' }],
			{
				typeMappings: [
					{
						objectType: 'task',
						defaultStatus: 'todo',
						dedupKeys: ['title', 'metadata.email'],
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
							{
								sourceColumn: 'email',
								targetField: 'metadata.email',
								transform: 'none',
								skip: false,
							},
							{ sourceColumn: 'state', targetField: 'status', transform: 'none', skip: false },
						],
					},
				],
				relationships: [],
			},
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(result.successCount).toBe(0)
		expect(result.updatedCount).toBe(0)
		expect(result.skippedCount).toBe(1)

		const [after] = await db.select().from(objects).where(eq(objects.id, stored.id))
		expect(after?.status).toBe('in_progress')

		const audit = await fetchAuditForImport(importId)
		expect(audit).toHaveLength(1)
		expect(audit[0]?.action).toBe('skipped')
		expect(audit[0]?.changedColumns).toEqual([])
	})

	// === NEW: regression for duplicate-tuple binding ===
	it('duplicate-tuple CSV rows bind to the same existing object (no second-row create)', async () => {
		const { workspaceId, actorId, importId } = await setupImportFixture()

		const [stored] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: 'task',
				title: 'Pick CRM',
				content: 'old description',
				status: 'todo',
				metadata: { email: 'crm@example.com' },
				createdBy: actorId,
			})
			.returning()
		if (!stored) throw new Error('seed insert failed')

		const result = await executeImport(
			importId,
			[
				{ name: 'Pick CRM', email: 'crm@example.com', description: 'first edit' },
				{ name: 'Pick CRM', email: 'crm@example.com', description: 'second edit' },
			],
			{
				typeMappings: [
					{
						objectType: 'task',
						defaultStatus: 'todo',
						dedupKeys: ['title', 'metadata.email'],
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
							{
								sourceColumn: 'email',
								targetField: 'metadata.email',
								transform: 'none',
								skip: false,
							},
							{
								sourceColumn: 'description',
								targetField: 'content',
								transform: 'none',
								skip: false,
							},
						],
					},
				],
				relationships: [],
			},
			workspaceId,
			actorId,
			SETTINGS,
			db,
		)

		expect(result.successCount).toBe(0)
		expect(result.updatedCount).toBe(2)
		expect(result.skippedCount).toBe(0)

		const allTasks = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'task')))
		expect(allTasks).toHaveLength(1)

		const [after] = await db.select().from(objects).where(eq(objects.id, stored.id))
		expect(after?.content).toBe('second edit')

		const audit = await fetchAuditForImport(importId)
		expect(audit).toHaveLength(2)
		expect(audit.every((a) => a.action === 'updated')).toBe(true)
		expect(audit[0]?.oldValues).toEqual({ content: 'old description' })
		expect(audit[0]?.newValues).toEqual({ content: 'first edit' })
		expect(audit[1]?.oldValues).toEqual({ content: 'first edit' })
		expect(audit[1]?.newValues).toEqual({ content: 'second edit' })
	})
})
