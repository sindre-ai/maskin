import {
	buildCreateNotificationBody,
	buildNotification,
	buildWorkspaceMember,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: notificationsRoutes } = await import('../../routes/notifications')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

describe('Notifications Routes', () => {
	describe('POST /api/notifications', () => {
		it('creates a notification and returns 201', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insertQueue = [[notification], []]

			const res = await app.request(
				jsonRequest('POST', '/api/notifications', buildCreateNotificationBody(), headers),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
			expect(body.status).toBe('pending')
		})

		it('returns 400 when insert fails', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('POST', '/api/notifications', buildCreateNotificationBody(), headers),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/notifications', () => {
		it('returns 200 with list of notifications', async () => {
			const n1 = buildNotification({ workspaceId: wsId })
			const n2 = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [n1, n2]

			const res = await app.request(jsonGet('/api/notifications', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 200 with empty list', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(jsonGet('/api/notifications', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(0)
		})
	})

	describe('GET /api/notifications/:id', () => {
		it('returns 200 when notification found', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [notification]

			const res = await app.request(jsonGet(`/api/notifications/${notification.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonGet('/api/notifications/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/notifications/:id', () => {
		it('returns 200 when notification updated', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'seen' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.update = [notification]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/notifications/${notification.id}`,
					{ status: 'seen' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
		})

		it('returns 404 when notification not found', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.update = []

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/notifications/00000000-0000-0000-0000-000000000099',
					{ status: 'seen' },
					headers,
				),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/notifications/:id/respond', () => {
		it('returns 200 when responding to pending notification', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'pending' })
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [notification]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 when notification already resolved', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'resolved' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [notification]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond`,
					{ response: 'Too late' },
					headers,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('already responded')
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/00000000-0000-0000-0000-000000000099/respond',
					{ response: 'Hello' },
					headers,
				),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/notifications/:id', () => {
		it('returns 200 when notification deleted', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [notification]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('DELETE', `/api/notifications/${notification.id}`, undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonRequest(
					'DELETE',
					'/api/notifications/00000000-0000-0000-0000-000000000099',
					undefined,
					headers,
				),
			)

			expect(res.status).toBe(404)
		})
	})
})
