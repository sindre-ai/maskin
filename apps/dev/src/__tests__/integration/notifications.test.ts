import { events } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { buildCreateNotificationBody, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: notificationsRoutes } = await import('../../routes/notifications')

function createApp() {
	return createIntegrationApp({ path: '/api/notifications', module: notificationsRoutes })
}

describe('Notifications Integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	describe('CRUD lifecycle', () => {
		it('creates, reads, updates, responds, and deletes a notification', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications',
					buildCreateNotificationBody({ source_actor_id: getTestActorId() }),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.id).toBeDefined()
			expect(created.status).toBe('pending')
			expect(created.workspaceId).toBe(workspaceId)

			// List
			const listRes = await app.request(jsonGet('/api/notifications', headers))
			expect(listRes.status).toBe(200)
			const list = await listRes.json()
			expect(list.length).toBeGreaterThanOrEqual(1)

			// Get by ID
			const getRes = await app.request(jsonGet(`/api/notifications/${created.id}`))
			expect(getRes.status).toBe(200)
			const fetched = await getRes.json()
			expect(fetched.id).toBe(created.id)

			// Update
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/notifications/${created.id}`, { status: 'seen' }, headers),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.status).toBe('seen')

			// Respond
			const respondRes = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${created.id}/respond`,
					{ response: 'Approved by human' },
					headers,
				),
			)
			expect(respondRes.status).toBe(200)
			const responded = await respondRes.json()
			expect(responded.status).toBe('resolved')

			// Respond again should fail
			const respondAgainRes = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${created.id}/respond`,
					{ response: 'Too late' },
					headers,
				),
			)
			expect(respondAgainRes.status).toBe(400)

			// Delete
			const deleteRes = await app.request(
				jsonRequest('DELETE', `/api/notifications/${created.id}`, undefined, headers),
			)
			expect(deleteRes.status).toBe(200)

			// Verify deleted
			const getDeletedRes = await app.request(jsonGet(`/api/notifications/${created.id}`))
			expect(getDeletedRes.status).toBe(404)
		})
	})

	describe('events audit trail', () => {
		it('creates events for mutations', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create notification
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications',
					buildCreateNotificationBody({ source_actor_id: getTestActorId() }),
					headers,
				),
			)
			const created = await createRes.json()

			// Check events were created
			const auditEvents = await db.select().from(events).where(eq(events.entityId, created.id))

			expect(auditEvents.length).toBeGreaterThanOrEqual(1)
			expect(auditEvents.some((e) => e.action === 'created')).toBe(true)
		})
	})
})
