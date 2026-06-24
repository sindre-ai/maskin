import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildImport, buildWorkspace, buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

// Mock the import-processor to avoid real CSV parsing
vi.mock('../../services/import-processor', () => ({
	parseFile: vi.fn().mockReturnValue({
		columns: ['name', 'status'],
		rows: [
			{ name: 'Item 1', status: 'todo' },
			{ name: 'Item 2', status: 'done' },
		],
	}),
	detectCsvOptions: vi.fn().mockReturnValue({ delimiter: ',', encoding: 'utf-8' }),
	generateMapping: vi.fn().mockReturnValue({
		typeMappings: [
			{
				objectType: 'task',
				columns: [
					{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
					{ sourceColumn: 'status', targetField: 'status', transform: 'none', skip: false },
				],
				defaultStatus: 'todo',
			},
		],
		relationships: [],
	}),
	executeImport: vi.fn(),
	matchRowsByDedupKeys: vi.fn().mockResolvedValue({
		updated: [],
		createdRowIndices: [0, 1],
		skippedRowIndices: [],
	}),
}))

const { parseFile, generateMapping, matchRowsByDedupKeys } = await import(
	'../../services/import-processor'
)
const { default: importsRoutes } = await import('../../routes/imports')

const wsId = '00000000-0000-0000-0000-000000000001'
const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })

describe('GET /api/imports/:id', () => {
	it('returns import details', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId })
		// First select: membership check, second select: findImport
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(jsonGet(`/api/imports/${imp.id}`, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(imp.id)
		expect(body.status).toBe('mapping')
	})

	it('returns 404 for non-existent import', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[member], []]

		const res = await app.request(
			jsonGet(`/api/imports/${crypto.randomUUID()}`, { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(404)
	})

	it('returns 403 for non-member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonGet(`/api/imports/${crypto.randomUUID()}`, { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(403)
	})
})

describe('GET /api/imports', () => {
	it('returns list of imports', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(jsonGet('/api/imports', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(Array.isArray(body)).toBe(true)
	})

	it('returns 403 for non-member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

		const res = await app.request(jsonGet('/api/imports', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(403)
	})
})

describe('PATCH /api/imports/:id/mapping', () => {
	beforeEach(() => {
		vi.mocked(generateMapping).mockClear()
	})

	it('updates mapping when import is in mapping state', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		mockResults.selectQueue = [[member], [imp]]
		mockResults.update = [imp]

		const newMapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'title', targetField: 'title', transform: 'none', skip: false },
					],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
		}

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${imp.id}/mapping`,
				{ mapping: newMapping },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(200)
	})

	it('preserves user objectType when csvOptions key order differs but values match', async () => {
		// Regression for the bug where Postgres JSONB returns csvOptions with keys in a
		// different order than Zod's parsed input ({encoding, delimiter} vs {delimiter,
		// encoding}). The route used JSON.stringify(...) for comparison, which is order-
		// sensitive, so it spuriously detected a CSV-options change and regenerated the
		// mapping — overwriting the user's chosen objectType with validTypes[0] ('bet').
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({
			workspaceId: wsId,
			status: 'mapping',
			mapping: {
				typeMappings: [
					{
						objectType: 'bet',
						columns: [
							{ sourceColumn: 'title', targetField: 'title', transform: 'none', skip: false },
						],
						defaultStatus: 'signal',
					},
				],
				relationships: [],
				// Postgres JSONB shape: encoding before delimiter
				csvOptions: { encoding: 'utf-8', delimiter: ',' },
			},
		})
		mockResults.selectQueue = [[member], [imp]]
		mockResults.update = [imp]

		const userMapping = {
			typeMappings: [
				{
					objectType: 'task',
					columns: [
						{ sourceColumn: 'title', targetField: 'title', transform: 'none', skip: false },
					],
					defaultStatus: 'todo',
				},
			],
			relationships: [],
			// Zod-parsed shape: delimiter before encoding (same values)
			csvOptions: { delimiter: ',', encoding: 'utf-8' },
		}

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${imp.id}/mapping`,
				{ mapping: userMapping },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(200)
		// generateMapping must NOT be called — csvOptions didn't actually change
		expect(generateMapping).not.toHaveBeenCalled()
	})

	it('regenerates mapping when csvOptions actually change', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(importsRoutes, '/api/imports')
		const ws = buildWorkspace({ id: wsId })
		const imp = buildImport({
			workspaceId: wsId,
			status: 'mapping',
			mapping: {
				typeMappings: [{ objectType: 'task', columns: [], defaultStatus: 'todo' }],
				relationships: [],
				csvOptions: { delimiter: ',', encoding: 'utf-8' },
			},
		})
		mockResults.selectQueue = [[member], [imp], [ws]]
		mockResults.update = [imp]
		vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from('a;b\n1;2'))

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${imp.id}/mapping`,
				{
					mapping: {
						typeMappings: [{ objectType: 'task', columns: [], defaultStatus: 'todo' }],
						relationships: [],
						csvOptions: { delimiter: ';', encoding: 'utf-8' },
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(200)
		expect(generateMapping).toHaveBeenCalledTimes(1)
	})

	it('returns 409 when import is not in mapping state', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'completed' })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${imp.id}/mapping`,
				{
					mapping: {
						typeMappings: [{ objectType: 'task', columns: [] }],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(409)
	})

	it('returns 404 when import not found', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[member], []]

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${crypto.randomUUID()}/mapping`,
				{
					mapping: {
						typeMappings: [{ objectType: 'task', columns: [] }],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(404)
	})

	it('returns 403 for non-member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${crypto.randomUUID()}/mapping`,
				{
					mapping: {
						typeMappings: [{ objectType: 'task', columns: [] }],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(403)
	})
})

describe('POST /api/imports/:id/confirm', () => {
	it('returns 202 when import is confirmed and starts background execution', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		const updatedImp = { ...imp, status: 'importing' }
		// membership check, findImport, workspace (type validation), atomic update returns updated
		mockResults.selectQueue = [[member], [imp], [ws]]
		mockResults.update = [updatedImp]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(202)
		const body = await res.json()
		expect(body.status).toBe('importing')
	})

	it('returns 400 when mapping references a type not in workspace settings', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({
			workspaceId: wsId,
			status: 'mapping',
			mapping: {
				typeMappings: [
					{
						objectType: 'lead',
						columns: [
							{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false },
						],
						defaultStatus: 'new',
					},
				],
				relationships: [],
			},
		})
		const ws = buildWorkspace({ id: wsId })
		// membership check, findImport, workspace (type validation rejects 'lead')
		mockResults.selectQueue = [[member], [imp], [ws]]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain("Invalid object type 'lead'")
	})

	it('returns 409 when atomic status transition fails (concurrent claim)', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		// membership check, findImport, workspace, then atomic update returns empty (race)
		mockResults.selectQueue = [[member], [imp], [ws]]
		mockResults.update = []

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(409)
	})

	it('returns 404 when import not found', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[member], []]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${crypto.randomUUID()}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(404)
	})

	it('returns 409 when import is not in mapping state', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'completed' })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(409)
	})

	it('returns 400 when no mapping configured', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping', mapping: null })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 403 for non-member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${crypto.randomUUID()}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(403)
	})
})

describe('POST /api/imports (file upload)', () => {
	it('returns 201 when CSV file is uploaded successfully', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const workspace = buildWorkspace({ id: wsId })
		const imp = buildImport({ workspaceId: wsId })
		// membership check, workspace lookup, insert import record, insert event
		mockResults.selectQueue = [[member], [workspace]]
		mockResults.insert = [imp]

		const formData = new FormData()
		formData.append(
			'file',
			new File(['name,status\nItem 1,todo'], 'test.csv', { type: 'text/csv' }),
		)

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(201)
	})

	it('returns 400 when no file is provided', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const workspace = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [workspace]]

		const formData = new FormData()

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('No file provided')
	})

	it('returns 400 when file is too large (>10MB)', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const workspace = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [workspace]]

		// Create a file larger than 10MB
		const largeContent = 'x'.repeat(11 * 1024 * 1024)
		const formData = new FormData()
		formData.append('file', new File([largeContent], 'big.csv', { type: 'text/csv' }))

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('File too large')
	})

	it('returns 400 for unsupported file type (.xlsx)', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const workspace = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [workspace]]

		const formData = new FormData()
		formData.append('file', new File(['data'], 'test.xlsx', { type: 'application/vnd.ms-excel' }))

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('Unsupported file type')
	})

	it('returns 400 when file parsing fails', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const workspace = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [workspace]]

		vi.mocked(parseFile).mockImplementationOnce(() => {
			throw new Error('Invalid CSV format')
		})

		const formData = new FormData()
		formData.append('file', new File(['bad,data\n"unclosed'], 'bad.csv', { type: 'text/csv' }))

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('Failed to parse file')
	})

	it('returns 404 when workspace not found', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		// membership check passes, workspace lookup returns empty
		mockResults.selectQueue = [[member], []]

		const formData = new FormData()
		formData.append('file', new File(['name\nTest'], 'test.csv', { type: 'text/csv' }))

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error.message).toContain('Workspace not found')
	})

	it('returns 403 when not a workspace member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

		const formData = new FormData()
		formData.append('file', new File(['name\nTest'], 'test.csv', { type: 'text/csv' }))

		const req = new Request('http://localhost/api/imports', {
			method: 'POST',
			headers: { 'x-workspace-id': wsId },
			body: formData,
		})

		const res = await app.request(req)
		expect(res.status).toBe(403)
	})
})

describe('POST /api/imports/:id/preview', () => {
	beforeEach(() => {
		vi.mocked(matchRowsByDedupKeys).mockClear()
	})

	function previewMapping(overrides?: Record<string, unknown>) {
		return {
			typeMappings: [
				{
					objectType: 'task',
					columns: [{ sourceColumn: 'name', targetField: 'title', transform: 'none', skip: false }],
					defaultStatus: 'todo',
					dedupKeys: ['title'],
					...(overrides ?? {}),
				},
			],
			relationships: [],
		}
	}

	it('returns counts and diffs from the matching engine', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]
		vi.mocked(matchRowsByDedupKeys).mockResolvedValueOnce({
			updated: [
				{
					rowIndex: 0,
					objectId: '11111111-1111-1111-1111-111111111111',
					changes: [{ column: 'title', old: 'Old', new: 'Item 1' }],
				},
			],
			createdRowIndices: [1],
			skippedRowIndices: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${imp.id}/preview`,
				{ mapping: previewMapping() },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.matched).toBe(1)
		expect(body.created).toBe(1)
		expect(body.skipped).toBe(0)
		expect(body.diffs).toHaveLength(1)
		expect(body.diffs[0]).toEqual({
			row_index: 0,
			object_id: '11111111-1111-1111-1111-111111111111',
			changes: [{ column: 'title', old: 'Old', new: 'Item 1' }],
		})
	})

	it('caps diffs at 25 even when more rows matched', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]
		const updated = Array.from({ length: 40 }, (_, i) => ({
			rowIndex: i,
			objectId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
			changes: [{ column: 'title', old: `Old ${i}`, new: `New ${i}` }],
		}))
		vi.mocked(matchRowsByDedupKeys).mockResolvedValueOnce({
			updated,
			createdRowIndices: [],
			skippedRowIndices: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${imp.id}/preview`,
				{ mapping: previewMapping() },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.matched).toBe(40)
		expect(body.diffs).toHaveLength(25)
		// Diffs are sorted by row_index — the cap keeps the lowest indices.
		expect(body.diffs[0].row_index).toBe(0)
		expect(body.diffs[24].row_index).toBe(24)
	})

	it('returns 400 when dedupKeys references a non-existent field on the target type', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${imp.id}/preview`,
				{ mapping: previewMapping({ dedupKeys: ['metadata.unknown_field'] }) },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('Invalid dedup key')
		expect(body.error.message).toContain('unknown_field')
		expect(matchRowsByDedupKeys).not.toHaveBeenCalled()
	})

	it('returns 400 when no dedupKeys and no createAllAsNew (AC-U4 backstop)', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${imp.id}/preview`,
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
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('pick at least one field')
	})

	it('accepts empty dedupKeys when createAllAsNew is true', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]
		vi.mocked(matchRowsByDedupKeys).mockResolvedValueOnce({
			updated: [],
			createdRowIndices: [0, 1],
			skippedRowIndices: [],
		})

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${imp.id}/preview`,
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
								createAllAsNew: true,
							},
						],
						relationships: [],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.matched).toBe(0)
		expect(body.created).toBe(2)
	})

	it('returns 409 when import is not in mapping state', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'importing' })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${imp.id}/preview`,
				{ mapping: previewMapping() },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(409)
	})

	it('returns 404 for non-existent import', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[member], []]

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${crypto.randomUUID()}/preview`,
				{ mapping: previewMapping() },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(404)
	})

	it('returns 403 for non-member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/imports/${crypto.randomUUID()}/preview`,
				{ mapping: previewMapping() },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(403)
	})
})

describe('POST /api/imports/:id/confirm — dedup key validation (AC-U4 backstop)', () => {
	it('returns 400 when stored mapping has no dedupKeys and no createAllAsNew', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({
			workspaceId: wsId,
			status: 'mapping',
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
					},
				],
				relationships: [],
			},
		})
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('pick at least one field')
	})

	it('returns 400 when stored mapping references a non-existent metadata field', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({
			workspaceId: wsId,
			status: 'mapping',
			mapping: {
				typeMappings: [
					{
						objectType: 'task',
						columns: [
							{
								sourceColumn: 'email',
								targetField: 'metadata.email',
								transform: 'none',
								skip: false,
							},
						],
						defaultStatus: 'todo',
						dedupKeys: ['metadata.nonexistent'],
					},
				],
				relationships: [],
			},
		})
		const ws = buildWorkspace({ id: wsId })
		mockResults.selectQueue = [[member], [imp], [ws]]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('Invalid dedup key')
	})

	it('returns 202 when stored mapping has a valid dedupKey (title)', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({
			workspaceId: wsId,
			status: 'mapping',
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
						dedupKeys: ['title'],
					},
				],
				relationships: [],
			},
		})
		const ws = buildWorkspace({ id: wsId })
		const updatedImp = { ...imp, status: 'importing' }
		mockResults.selectQueue = [[member], [imp], [ws]]
		mockResults.update = [updatedImp]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(202)
	})
})

describe('GET /api/imports (query params)', () => {
	it('accepts status query parameter', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'completed' })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(
			jsonGet('/api/imports?status=completed', { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(Array.isArray(body)).toBe(true)
	})

	it('accepts limit and offset query parameters', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId })
		mockResults.selectQueue = [[member], [imp]]

		const res = await app.request(
			jsonGet('/api/imports?limit=1&offset=0', { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(Array.isArray(body)).toBe(true)
	})
})
