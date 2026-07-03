import { OpenAPIHono } from '@hono/zod-openapi'
import { imports } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: importsRoutes } = await import('../../routes/imports')

// The shared integration helper doesn't provide a StorageProvider — the imports
// preview route reads the raw file from storage. Wire one up locally so the
// test can hand any CSV buffer to the route without touching SeaweedFS.
function createImportsApp(fileBuffer: Buffer) {
	const app = new OpenAPIHono()
	const storageProvider = {
		get: async () => fileBuffer,
		put: async () => {},
		delete: async () => {},
		list: async () => [],
		exists: async () => true,
		ensureBucket: async () => {},
	} as unknown as StorageProvider

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('storageProvider', storageProvider)
		await next()
	})
	app.route('/api/imports', importsRoutes)
	return app
}

async function insertImport(
	workspaceId: string,
	actorId: string,
	mapping: Record<string, unknown>,
) {
	const [row] = await db
		.insert(imports)
		.values({
			workspaceId,
			status: 'mapping',
			fileName: 'test.csv',
			fileType: 'csv',
			fileStorageKey: `imports/${workspaceId}/test.csv`,
			mapping,
			createdBy: actorId,
		})
		.returning()
	if (!row) throw new Error('Failed to insert test import row')
	return row
}

describe('Imports preview integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				display_names: { task: 'Task' },
				statuses: { task: ['todo', 'in_progress', 'done'] },
				// Declared on the task type so dedupKeys = ['metadata.email'] is
				// recognized by the validator in the metadata-key tests below.
				field_definitions: {
					task: [{ name: 'email', type: 'text' }],
				},
			},
		})
		workspaceId = ws.id
	})

	it('returns correct matched / created / skipped counts and capped diffs (AC-U2)', async () => {
		const actorId = getTestActorId()
		// Three existing rows — two will be matched, one of those has a real
		// diff (→ updated), the other has no diff (→ skipped), plus one new
		// title that will be classified as create.
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Existing-Update',
			status: 'todo',
		})
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Existing-Skip',
			status: 'todo',
		})

		// CSV: row 0 matches Existing-Update with a status diff, row 1 matches
		// Existing-Skip with the same status (no diff → skipped), rows 2 and 3
		// don't match anything (→ created).
		const csv = Buffer.from(
			[
				'name,status',
				'Existing-Update,in_progress',
				'Existing-Skip,todo',
				'Brand-New-1,todo',
				'Brand-New-2,todo',
			].join('\n'),
		)
		const app = createImportsApp(csv)

		const importRow = await insertImport(workspaceId, actorId, {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
						{ sourceColumn: 'status', targetField: 'status', transform: 'none', skip: false },
					],
					defaultStatus: 'todo',
					dedupKeys: ['title'],
				},
			],
			relationships: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${importRow.id}/preview`,
				{
					mapping: {
						typeMappings: [
							{
								objectType: 'task',
								columns: [
									{
										sourceColumn: 'name',
										targetField: 'title',
										transform: 'none',
										skip: false,
									},
									{
										sourceColumn: 'status',
										targetField: 'status',
										transform: 'none',
										skip: false,
									},
								],
								defaultStatus: 'todo',
								dedupKeys: ['title'],
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.matched).toBe(1)
		expect(body.created).toBe(2)
		expect(body.skipped).toBe(1)
		expect(body.diffs).toHaveLength(1)
		expect(body.diffs[0].row_index).toBe(0)
		expect(body.diffs[0].changes).toContainEqual({
			column: 'status',
			old: 'todo',
			new: 'in_progress',
		})
	})

	it('caps diffs at 25 even when more rows would have changes', async () => {
		const actorId = getTestActorId()

		// Seed 40 existing rows with status='todo'.
		for (let i = 0; i < 40; i++) {
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				title: `Item-${i}`,
				status: 'todo',
			})
		}

		// CSV flips every row's status → 40 diffs would be present without the cap.
		const lines = ['name,status']
		for (let i = 0; i < 40; i++) lines.push(`Item-${i},in_progress`)
		const app = createImportsApp(Buffer.from(lines.join('\n')))

		const importRow = await insertImport(workspaceId, actorId, {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
						{ sourceColumn: 'status', targetField: 'status', transform: 'none', skip: false },
					],
					defaultStatus: 'todo',
					dedupKeys: ['title'],
				},
			],
			relationships: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${importRow.id}/preview`,
				{
					mapping: {
						typeMappings: [
							{
								objectType: 'task',
								columns: [
									{
										sourceColumn: 'name',
										targetField: 'title',
										transform: 'none',
										skip: false,
									},
									{
										sourceColumn: 'status',
										targetField: 'status',
										transform: 'none',
										skip: false,
									},
								],
								defaultStatus: 'todo',
								dedupKeys: ['title'],
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.matched).toBe(40)
		expect(body.diffs).toHaveLength(25)
	})

	it('matches existing rows on a metadata.<field> JSONB key path', async () => {
		const actorId = getTestActorId()
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: 'Alice',
			status: 'todo',
			metadata: { email: 'alice@example.com' },
		})

		const csv = Buffer.from(
			['name,email', 'Alice Renamed,alice@example.com', 'Bob,bob@example.com'].join('\n'),
		)
		const app = createImportsApp(csv)

		const importRow = await insertImport(workspaceId, actorId, {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
						{
							sourceColumn: 'email',
							targetField: 'metadata.email',
							transform: 'none',
							skip: false,
						},
					],
					defaultStatus: 'todo',
					dedupKeys: ['metadata.email'],
				},
			],
			relationships: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${importRow.id}/preview`,
				{
					mapping: {
						typeMappings: [
							{
								objectType: 'task',
								columns: [
									{
										sourceColumn: 'name',
										targetField: 'title',
										transform: 'none',
										skip: false,
									},
									{
										sourceColumn: 'email',
										targetField: 'metadata.email',
										transform: 'none',
										skip: false,
									},
								],
								defaultStatus: 'todo',
								dedupKeys: ['metadata.email'],
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.matched).toBe(1)
		expect(body.created).toBe(1)
		expect(body.diffs[0]).toMatchObject({
			row_index: 0,
			changes: expect.arrayContaining([{ column: 'title', old: 'Alice', new: 'Alice Renamed' }]),
		})
	})

	it('rejects preview when dedupKeys references a field that does not exist on the target type', async () => {
		const actorId = getTestActorId()
		const app = createImportsApp(Buffer.from('name\nFoo'))
		const importRow = await insertImport(workspaceId, actorId, {
			typeMappings: [
				{
					objectType: 'task',
					columns: [{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false }],
					defaultStatus: 'todo',
					dedupKeys: ['metadata.does_not_exist'],
				},
			],
			relationships: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${importRow.id}/preview`,
				{
					mapping: {
						typeMappings: [
							{
								objectType: 'task',
								columns: [
									{
										sourceColumn: 'name',
										targetField: 'title',
										transform: 'none',
										skip: false,
									},
								],
								defaultStatus: 'todo',
								dedupKeys: ['metadata.does_not_exist'],
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('Invalid dedup key')
	})

	it('confirm rejects an import with no dedupKeys and no createAllAsNew (AC-U4 backstop)', async () => {
		const actorId = getTestActorId()
		const app = createImportsApp(Buffer.from('name\nFoo'))
		const importRow = await insertImport(workspaceId, actorId, {
			typeMappings: [
				{
					objectType: 'task',
					columns: [{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false }],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
		})

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${importRow.id}/confirm`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('pick at least one field')

		// Confirm the import was never moved to 'importing' — the backstop
		// must fail closed and leave the import in 'mapping' for the user to fix.
		const [row] = await db.select().from(imports).where(eq(imports.id, importRow.id))
		expect(row?.status).toBe('mapping')
	})

	it('rows with an empty dedup-key value route to "create" (AC-T3)', async () => {
		const actorId = getTestActorId()
		await insertObject(db, workspaceId, actorId, {
			type: 'task',
			title: '',
			status: 'todo',
		})

		// The CSV row also has an empty title — per AC-T3 it must NOT match the
		// existing empty-title row and must classify as "create".
		const csv = Buffer.from(['name,status', ',todo'].join('\n'))
		const app = createImportsApp(csv)

		const importRow = await insertImport(workspaceId, actorId, {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
						{ sourceColumn: 'status', targetField: 'status', transform: 'none', skip: false },
					],
					defaultStatus: 'todo',
					dedupKeys: ['title'],
				},
			],
			relationships: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${importRow.id}/preview`,
				{
					mapping: {
						typeMappings: [
							{
								objectType: 'task',
								columns: [
									{
										sourceColumn: 'name',
										targetField: 'title',
										transform: 'none',
										skip: false,
									},
									{
										sourceColumn: 'status',
										targetField: 'status',
										transform: 'none',
										skip: false,
									},
								],
								defaultStatus: 'todo',
								dedupKeys: ['title'],
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		// 1 created (the empty-title row), 0 matched, 0 skipped.
		expect(body.matched).toBe(0)
		expect(body.created).toBe(1)
		expect(body.skipped).toBe(0)
	})
})
