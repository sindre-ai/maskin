import {
	buildCreateObjectBody,
	buildEvent,
	buildObject,
	buildRelationship,
	buildUpdateObjectBody,
	buildWorkspace,
	buildWorkspaceMember,
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
			expect(body.error.message).toContain('Workspace not found')
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
			expect(body.error.message).toContain('Invalid status')
		})

		it('returns 400 for invalid object type', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ type: 'nonexistent' }), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid object type')
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

		it('returns 200 with sort and order params', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(
				jsonGet('/api/objects?sort=title&order=asc', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 for invalid sort field', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?sort=;DROP TABLE', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('returns 200 for metadata sort field', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.select = [obj]

			const res = await app.request(
				jsonGet('/api/objects?sort=metadata.priority', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 for unknown sort field', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(jsonGet('/api/objects?sort=foobar', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(400)
		})

		it('returns 400 for metadata sort field with dots', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?sort=metadata.a.b', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 for invalid order value', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonGet('/api/objects?order=invalid', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
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
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]
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
			// First select: existing object, second: workspace membership, third: workspace settings
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'bogus_status' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid status')
		})

		it('merges metadata instead of replacing it', async () => {
			const existing = buildObject({
				metadata: { linkedin_url: 'https://linkedin.com/in/test', company: 'Acme' },
			})
			const merged = {
				...existing,
				metadata: {
					linkedin_url: 'https://linkedin.com/in/test',
					company: 'Acme',
					priority: 'hot',
				},
			}
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]
			mockResults.update = [merged]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, {
					metadata: { priority: 'hot' },
				}),
			)

			expect(res.status).toBe(200)
			// Verify the update was called with merged metadata (existing + new)
			const body = await res.json()
			expect(body.metadata).toEqual({
				linkedin_url: 'https://linkedin.com/in/test',
				company: 'Acme',
				priority: 'hot',
			})
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
		it('returns 200 with object, relationships, connected objects, and events', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const connectedObj = buildObject({ workspaceId: wsId })
			const rel = buildRelationship({
				sourceId: obj.id,
				targetId: connectedObj.id,
			})
			const comment = buildEvent({
				workspaceId: wsId,
				entityType: 'object',
				entityId: obj.id,
				action: 'commented',
				data: { content: 'looks good' },
			})
			const lifecycleEvent = buildEvent({
				workspaceId: wsId,
				entityType: obj.type,
				entityId: obj.id,
				action: 'created',
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: target object, second: relationships, third: connected objects, fourth: events
			mockResults.selectQueue = [[obj], [rel], [connectedObj], [comment, lifecycleEvent]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(1)
			expect(body.connected_objects).toHaveLength(1)
			expect(body.events).toHaveLength(2)
			expect(body.events[0].action).toBe('commented')
			// Server-side formatted description matches what the UI renders
			expect(body.events[1].description).toBe('proposed bet')
		})

		it('resolves actor names for owner-change events in description', async () => {
			const obj = buildObject({ workspaceId: wsId, type: 'bet' })
			const alice = { id: '00000000-0000-0000-0000-0000000000a1', name: 'Alice' }
			const bob = { id: '00000000-0000-0000-0000-0000000000b2', name: 'Bob' }
			const ownerChange = buildEvent({
				workspaceId: wsId,
				entityType: 'bet',
				entityId: obj.id,
				action: 'updated',
				data: {
					previous: { owner: alice.id },
					updated: { owner: bob.id },
				},
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1: object, 2: relationships (empty → skips connected_objects fetch), 3: events, 4: actors
			mockResults.selectQueue = [[obj], [], [ownerChange], [alice, bob]]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.events).toHaveLength(1)
			expect(body.events[0].description).toBe('changed owner from Alice to Bob')
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
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()]]
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

	describe('POST /api/objects - edge cases', () => {
		it('returns 500 when insert returns empty', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]
			mockResults.insert = [] // empty — insert failed

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('Failed to create object')
		})
	})

	describe('PATCH /api/objects/:id - status_changed event', () => {
		it('logs status_changed event when status changes', async () => {
			const existing = buildObject({ status: 'todo' })
			const updated = { ...existing, status: 'in_progress' }
			const ws = buildWorkspace({ id: existing.workspaceId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: existing object, second: workspace membership, third: workspace settings
			mockResults.selectQueue = [[existing], [buildWorkspaceMember()], [ws]]
			mockResults.update = [updated]
			mockResults.insert = [{}] // event insert

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, { status: 'in_progress' }),
			)

			expect(res.status).toBe(200)
		})
	})

	describe('GET /api/objects/:id/graph - no relationships', () => {
		it('returns empty arrays when no relationships or events exist', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// First select: the object, second: relationships (empty), third: events (empty)
			mockResults.selectQueue = [[obj], [], []]

			const res = await app.request(
				jsonGet(`/api/objects/${obj.id}/graph`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.object.id).toBe(obj.id)
			expect(body.relationships).toHaveLength(0)
			expect(body.connected_objects).toHaveLength(0)
			expect(body.events).toHaveLength(0)
		})
	})

	describe('Workspace membership enforcement', () => {
		it('GET /:id returns 404 when actor is not a workspace member', async () => {
			const obj = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Object found, but membership check returns empty
			mockResults.selectQueue = [[obj], []]

			const res = await app.request(jsonGet(`/api/objects/${obj.id}`))
			expect(res.status).toBe(404)
		})

		it('PATCH /:id returns 404 when actor is not a workspace member', async () => {
			const existing = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Object found, but membership check returns empty
			mockResults.selectQueue = [[existing], []]

			const res = await app.request(
				jsonRequest('PATCH', `/api/objects/${existing.id}`, buildUpdateObjectBody()),
			)
			expect(res.status).toBe(404)
		})

		it('DELETE /:id returns 404 when actor is not a workspace member', async () => {
			const existing = buildObject()
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// Object found, but membership check returns empty
			mockResults.selectQueue = [[existing], []]

			const res = await app.request(jsonDelete(`/api/objects/${existing.id}`))
			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/objects/migrate-type', () => {
		it('returns 200 and migrates rows to the new type', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj1 = buildObject({ workspaceId: wsId, type: 'task', status: 'todo' })
			const obj2 = buildObject({ workspaceId: wsId, type: 'task', status: 'done' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) workspace lookup, 2) rows of fromType
			mockResults.selectQueue = [[ws], [obj1, obj2]]
			// 2 update calls + 2 event inserts inside the transaction
			mockResults.update = [{}]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({
				mode: 'migrate',
				fromType: 'task',
				toType: 'bet',
				count: 2,
			})
		})

		it('returns 200 and 0 count when fromType has no rows', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.count).toBe(0)
		})

		it('returns 400 for invalid toType', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'nonexistent', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when mode=migrate omits toType', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when fromType equals toType', async () => {
			const { app } = createTestApp(objectsRoutes, '/api/objects')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'task', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 200 and deletes rows in delete mode', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj1 = buildObject({ workspaceId: wsId, type: 'task' })
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			// 1) workspace lookup, 2) rows to delete (id list)
			mockResults.selectQueue = [[ws], [{ id: obj1.id }]]
			mockResults.delete = [{}]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', mode: 'delete' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({ mode: 'delete', fromType: 'task', count: 1 })
		})

		it('applies statusMap and falls back when target lacks the source status', async () => {
			const ws = buildWorkspace({ id: wsId })
			// 'task' statuses → ['todo', 'in_progress', 'done', 'blocked']
			// 'bet'  statuses → ['signal', 'proposed', 'active', ...] — no overlap
			const obj1 = buildObject({ workspaceId: wsId, type: 'task', status: 'todo' })
			const obj2 = buildObject({ workspaceId: wsId, type: 'task', status: 'done' })
			const { app, mockResults, calls } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws], [obj1, obj2]]
			mockResults.update = [{}]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{
						fromType: 'task',
						toType: 'bet',
						mode: 'migrate',
						// 'todo' is mapped explicitly; 'done' has no entry → uses fallback
						statusMap: { todo: 'active' },
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			// First update: 'todo' → 'active' via statusMap
			expect(calls.updates[0]).toMatchObject({ type: 'bet', status: 'active' })
			// Second update: 'done' isn't a valid bet status and isn't in statusMap → first bet status
			expect(calls.updates[1]).toMatchObject({ type: 'bet', status: 'signal' })
		})

		it('returns 400 when target type has no statuses configured', async () => {
			const ws = buildWorkspace({
				id: wsId,
				settings: {
					enabled_modules: ['work'],
					display_names: { bet: 'Bet', task: 'Task' },
					statuses: {
						task: ['todo', 'done'],
						bet: [],
					},
				},
			})
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 404 when workspace not found', async () => {
			const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/objects/migrate-type',
					{ fromType: 'task', toType: 'bet', mode: 'migrate' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})
	})
})
