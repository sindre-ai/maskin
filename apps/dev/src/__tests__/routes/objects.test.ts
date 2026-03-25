import {
	buildCreateObjectBody,
	buildObject,
	buildRelationship,
	buildUpdateObjectBody,
	buildWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Import the route module directly (not index.ts)
const { default: objectsRoutes } = await import('../../routes/objects')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Objects Routes', () => {
	describe('POST /api/objects', () => {
		it('creates an object and returns 201', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]
			mockResults.insert = [obj]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(obj.id)
			expect(body.type).toBe('task')
		})

		it('returns 404 when workspace not found', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
			const body = await res.json()
			expect(body.error).toContain('Workspace not found')
		})

		it('returns 400 for invalid status', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ status: 'nonexistent_status' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toContain('Invalid status')
		})
	})

	describe('GET /api/objects', () => {
		it('returns 200 with list of objects', async () => {
			const obj1 = buildObject({ workspaceId: wsId })
			const obj2 = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj1, obj2]

			const res = await app.request(jsonGet('/api/objects', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('GET /api/objects/:id', () => {
		it('returns 200 when object found', async () => {
			const obj = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(obj.id)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonGet('/api/objects/00000000-0000-0000-0000-000000000099'))

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/objects/:id', () => {
		it('returns 200 when object updated', async () => {
			const existing = buildObject()
			const updated = { ...existing, title: 'Updated title' }
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing]]
			mockResults.update = [updated]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, buildUpdateObjectBody()),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/objects/00000000-0000-0000-0000-000000000099',
					buildUpdateObjectBody(),
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for invalid status update', async () => {
			const existing = buildObject()
			const ws = buildWorkspace({ id: existing.workspaceId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select returns the existing object, second returns the workspace
			mockResults.selectQueue = [[existing], [ws]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'bogus_status' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toContain('Invalid status')
		})
	})

	describe('GET /api/objects/search', () => {
		it('returns 200 with search results', async () => {
			const obj1 = buildObject({ workspaceId: wsId, title: 'Login bug' })
			const obj2 = buildObject({ workspaceId: wsId, title: 'Signup flow' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj1, obj2]

			const res = await app.request(
				jsonGet('/api/objects/search?q=bug', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
		})
	})

	describe('GET /api/objects/:id/graph', () => {
		it('returns 200 with object, relationships, and connected objects', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const connectedObj = buildObject({ workspaceId: wsId })
			const rel = buildRelationship({
				sourceId: obj.id,
				targetId: connectedObj.id,
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: the target object, second: relationships, third: connected objects
			mockResults.selectQueue = [[obj], [rel], [connectedObj]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(1)
			expect(body.connected_objects).toHaveLength(1)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects/00000000-0000-0000-0000-000000000099/graph', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/objects/:id', () => {
		it('returns 200 when deleted', async () => {
			const existing = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing]]
			mockResults.insert = [{}] // event

			const res = await app.request(jsonDelete(`/api/objects/${existing.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when object not found', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonDelete('/api/objects/00000000-0000-0000-0000-000000000099'))

			expect(res.status).toBe(404)
		})
	})
})
