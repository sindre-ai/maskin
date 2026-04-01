import { describe, expect, it, vi } from 'vitest'
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
}))

const { parseFile } = await import('../../services/import-processor')
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
		const updatedImp = { ...imp, status: 'importing' }
		// membership check, findImport, atomic update returns updated
		mockResults.selectQueue = [[member], [imp]]
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

	it('returns 409 when atomic status transition fails (concurrent claim)', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		// membership check, findImport succeeds, but atomic update returns empty (race)
		mockResults.selectQueue = [[member], [imp]]
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
