import { describe, expect, it } from 'vitest'
import importsRoutes from '../../routes/imports'
import { buildImport, buildWorkspace, buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'

describe('GET /api/imports/:id', () => {
	it('returns import details', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId })
		mockResults.select = [imp]

		const res = await app.request(jsonGet(`/api/imports/${imp.id}`, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(imp.id)
		expect(body.status).toBe('mapping')
	})

	it('returns 404 for non-existent import', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.select = []

		const res = await app.request(
			jsonGet(`/api/imports/${crypto.randomUUID()}`, { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(404)
	})
})

describe('GET /api/imports', () => {
	it('returns list of imports', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId })
		mockResults.select = [imp]

		const res = await app.request(jsonGet('/api/imports', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(Array.isArray(body)).toBe(true)
	})
})

describe('PATCH /api/imports/:id/mapping', () => {
	it('updates mapping when import is in mapping state', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		const imp = buildImport({ workspaceId: wsId, status: 'mapping' })
		mockResults.selectQueue = [[imp]]
		mockResults.update = [imp]

		const newMapping = {
			objectType: 'task',
			columns: [{ sourceColumn: 'title', targetField: 'title', transform: 'none', skip: false }],
			defaultStatus: 'todo',
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
		mockResults.select = [imp]

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${imp.id}/mapping`,
				{
					mapping: {
						objectType: 'task',
						columns: [],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(409)
	})

	it('returns 404 when import not found', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.select = []

		const res = await app.request(
			jsonRequest(
				'PATCH',
				`/api/imports/${crypto.randomUUID()}/mapping`,
				{
					mapping: {
						objectType: 'task',
						columns: [],
					},
				},
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(404)
	})
})

describe('POST /api/imports/:id/confirm', () => {
	it('returns 404 when import not found', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.select = []

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
		mockResults.select = [imp]

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
		mockResults.select = [imp]

		const res = await app.request(
			jsonRequest('POST', `/api/imports/${imp.id}/confirm`, undefined, {
				'x-workspace-id': wsId,
			}),
		)
		expect(res.status).toBe(400)
	})
})
