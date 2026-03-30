import { describe, expect, it } from 'vitest'
import importsRoutes from '../../routes/imports'
import { buildImport, buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

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
		mockResults.selectQueue = [[member], [imp]]

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
		mockResults.selectQueue = [[member], []]

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

	it('returns 403 for non-member', async () => {
		const { app, mockResults } = createImportTestApp(importsRoutes, '/api/imports')
		mockResults.selectQueue = [[]]

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
