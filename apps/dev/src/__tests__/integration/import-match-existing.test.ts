import { events, imports, objects } from '@maskin/db/schema'
import type { ImportMapping } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import type { WorkspaceSettings } from '../../lib/types'
import { executeImport } from '../../services/import-processor'
import { buildImport, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const SETTINGS = {
	display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
	statuses: {
		insight: ['new', 'processing'],
		bet: ['signal', 'proposed'],
		task: ['todo', 'in_progress', 'done'],
	},
	field_definitions: {},
	relationship_types: ['informs'],
} as unknown as WorkspaceSettings

function companyMapping(overrides: {
	matchOn?: string
	onMatch?: ImportMapping['onMatch']
}): ImportMapping {
	return {
		typeMappings: [
			{
				objectType: 'insight',
				columns: [
					{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
					{
						sourceColumn: 'domain',
						targetField: 'metadata.domain',
						transform: 'none',
						skip: false,
					},
				],
				defaultStatus: 'new',
				...(overrides.matchOn ? { matchOn: overrides.matchOn } : {}),
			},
		],
		relationships: [],
		...(overrides.onMatch ? { onMatch: overrides.onMatch } : {}),
	}
}

describe('executeImport — matching existing objects', () => {
	let workspaceId: string
	let actorId: string
	let importId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, { settings: SETTINGS })
		workspaceId = ws.id
		const [row] = await db
			.insert(imports)
			.values(buildImport({ workspaceId, createdBy: actorId }))
			.returning()
		importId = row.id
	})

	function run(rows: Record<string, string>[], mapping: ImportMapping) {
		return executeImport(importId, rows, mapping, workspaceId, actorId, SETTINGS, db)
	}

	function listInsights() {
		return db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'insight')))
	}

	it('skips rows whose key matches an existing object, ignoring case and surrounding spaces', async () => {
		const existing = await insertObject(db, workspaceId, actorId, {
			type: 'insight',
			title: 'Acme Corp',
			status: 'processing',
			metadata: { domain: 'Acme.com' },
		})

		const result = await run(
			[
				{ name: 'Acme', domain: ' acme.com ' },
				{ name: 'Globex', domain: 'globex.com' },
			],
			companyMapping({ matchOn: 'metadata.domain' }),
		)

		expect(result).toMatchObject({ successCount: 1, skippedCount: 1, updatedCount: 0 })
		const rows = await listInsights()
		expect(rows).toHaveLength(2)
		const acme = rows.find((r) => r.id === existing.id)
		expect(acme?.title).toBe('Acme Corp')
		expect(acme?.status).toBe('processing')
	})

	it('creates one object when a key repeats within the file', async () => {
		const result = await run(
			[
				{ name: 'Globex', domain: 'globex.com' },
				{ name: 'Globex Inc', domain: 'GLOBEX.COM' },
			],
			companyMapping({ matchOn: 'metadata.domain' }),
		)

		expect(result).toMatchObject({ successCount: 1, skippedCount: 1 })
		const rows = await listInsights()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.title).toBe('Globex')
	})

	it('matches a key repeated across batches against the object an earlier batch created', async () => {
		// BATCH_SIZE is 50 — put the duplicate of row 0 in the second batch
		const rows = Array.from({ length: 60 }, (_, i) => ({
			name: `Company ${i}`,
			domain: `c${i}.com`,
		}))
		rows[55] = { name: 'Company 0 again', domain: 'c0.com' }

		const result = await run(rows, companyMapping({ matchOn: 'metadata.domain' }))

		expect(result).toMatchObject({ successCount: 59, skippedCount: 1 })
		expect(await listInsights()).toHaveLength(59)
	})

	it('updates the existing object in update mode, merging metadata and keeping an unmapped status', async () => {
		const existing = await insertObject(db, workspaceId, actorId, {
			type: 'insight',
			title: 'Acme',
			status: 'processing',
			metadata: { tier: 'a', domain: 'old.acme.com' },
		})

		const result = await run(
			[{ name: 'ACME ', domain: 'acme.com' }],
			companyMapping({ matchOn: 'title', onMatch: 'update' }),
		)

		expect(result).toMatchObject({ successCount: 0, skippedCount: 0, updatedCount: 1 })
		const rows = await listInsights()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe(existing.id)
		expect(rows[0]?.status).toBe('processing')
		expect(rows[0]?.metadata).toEqual({ tier: 'a', domain: 'acme.com' })

		const updateEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, existing.id), eq(events.action, 'updated')))
		expect(updateEvents).toHaveLength(1)
	})

	it('writes nothing when an update-mode row carries the values the object already has', async () => {
		const existing = await insertObject(db, workspaceId, actorId, {
			type: 'insight',
			title: 'Acme',
			status: 'new',
			metadata: { domain: 'acme.com' },
		})

		const result = await run(
			[{ name: 'Acme', domain: 'acme.com' }],
			companyMapping({ matchOn: 'metadata.domain', onMatch: 'update' }),
		)

		expect(result.updatedCount).toBe(1)
		const updateEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, existing.id), eq(events.action, 'updated')))
		expect(updateEvents).toHaveLength(0)
	})

	it('only matches objects of the same type in the same workspace', async () => {
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Acme',
			status: 'todo',
			metadata: { domain: 'acme.com' },
		})
		const otherWs = await insertWorkspace(db, actorId, { settings: SETTINGS })
		await insertObject(db, otherWs.id, actorId, {
			type: 'insight',
			title: 'Acme',
			status: 'new',
			metadata: { domain: 'acme.com' },
		})

		const result = await run(
			[{ name: 'Acme', domain: 'acme.com' }],
			companyMapping({ matchOn: 'metadata.domain' }),
		)

		expect(result).toMatchObject({ successCount: 1, skippedCount: 0 })
	})

	it('still creates duplicates when no match key is set', async () => {
		await insertObject(db, workspaceId, actorId, { type: 'insight', title: 'Acme', status: 'new' })

		const result = await run([{ name: 'Acme', domain: 'acme.com' }], companyMapping({}))

		expect(result.successCount).toBe(1)
		expect(await listInsights()).toHaveLength(2)
	})

	it('records skipped and updated counts on the import row', async () => {
		await insertObject(db, workspaceId, actorId, {
			type: 'insight',
			title: 'Acme',
			status: 'new',
			metadata: { domain: 'acme.com' },
		})

		await run(
			[
				{ name: 'Acme', domain: 'acme.com' },
				{ name: 'Globex', domain: 'globex.com' },
			],
			companyMapping({ matchOn: 'metadata.domain' }),
		)

		const [row] = await db.select().from(imports).where(eq(imports.id, importId))
		expect(row).toMatchObject({ successCount: 1, skippedCount: 1, updatedCount: 0 })
	})
})
