import { events } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { buildCreateObjectBody, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

describe('Objects Integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	describe('CRUD lifecycle', () => {
		it('creates, reads, updates, and deletes an object', async () => {
			const app = createApp()

			// Create
			const createRes = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.id).toBeDefined()
			expect(created.type).toBe('task')
			expect(created.status).toBe('todo')
			expect(created.workspaceId).toBe(workspaceId)

			// Read
			const getRes = await app.request(jsonGet(`/api/objects/${created.id}`))
			expect(getRes.status).toBe(200)
			const fetched = await getRes.json()
			expect(fetched.id).toBe(created.id)

			// Update
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/objects/${created.id}`, {
					title: 'Updated Title',
					status: 'in_progress',
				}),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.title).toBe('Updated Title')
			expect(updated.status).toBe('in_progress')

			// Delete
			const deleteRes = await app.request(jsonDelete(`/api/objects/${created.id}`))
			expect(deleteRes.status).toBe(200)

			// Verify gone
			const gone = await app.request(jsonGet(`/api/objects/${created.id}`))
			expect(gone.status).toBe(404)
		})
	})

	describe('event logging', () => {
		it('logs events on create, update, and delete', async () => {
			const app = createApp()

			// Create an object
			const createRes = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)
			const created = await createRes.json()

			// Update the object
			await app.request(jsonRequest('PATCH', `/api/objects/${created.id}`, { title: 'Changed' }))

			// Delete the object
			await app.request(jsonDelete(`/api/objects/${created.id}`))

			// Verify events were logged
			const logged = await db
				.select()
				.from(events)
				.where(eq(events.entityId, created.id))
				.orderBy(events.id)

			expect(logged).toHaveLength(3)
			expect(logged[0].action).toBe('created')
			expect(logged[1].action).toBe('updated')
			expect(logged[2].action).toBe('deleted')
		})
	})

	describe('status validation', () => {
		it('rejects invalid status for object type', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ status: 'nonexistent' }), {
					'x-workspace-id': workspaceId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid status')
		})
	})

	describe('workspace scoping', () => {
		it('lists only objects from the queried workspace', async () => {
			const app = createApp()
			const ws2 = await insertWorkspace(db, getTestActorId())

			// Create object in workspace 1
			await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': workspaceId,
				}),
			)

			// Create object in workspace 2
			await app.request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody(), {
					'x-workspace-id': ws2.id,
				}),
			)

			// List from workspace 1
			const res = await app.request(jsonGet('/api/objects', { 'x-workspace-id': workspaceId }))
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].workspaceId).toBe(workspaceId)
		})
	})

	describe('list filters', () => {
		it('filters by type and status', async () => {
			const app = createApp()

			await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'task', status: 'todo' }),
					{ 'x-workspace-id': workspaceId },
				),
			)
			await app.request(
				jsonRequest(
					'POST',
					'/api/objects',
					buildCreateObjectBody({ type: 'insight', status: 'new' }),
					{ 'x-workspace-id': workspaceId },
				),
			)

			const res = await app.request(
				jsonGet('/api/objects?type=task', { 'x-workspace-id': workspaceId }),
			)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].type).toBe('task')
		})
	})
})
