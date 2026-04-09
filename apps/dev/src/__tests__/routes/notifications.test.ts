import { buildCreateNotificationBody, buildNotification, buildWorkspaceMember } from '../factories'
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

		it('returns 500 when insert fails', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('POST', '/api/notifications', buildCreateNotificationBody(), headers),
			)

			expect(res.status).toBe(500)
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
			// First select: existing notification, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
			mockResults.update = [notification]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('PATCH', `/api/notifications/${notification.id}`, { status: 'seen' }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
		})

		it('returns 404 when notification not found', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('PATCH', '/api/notifications/00000000-0000-0000-0000-000000000099', {
					status: 'seen',
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/notifications/:id/respond', () => {
		it('returns 200 when responding to pending notification', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'pending' })
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// First select: notification lookup, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
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
			// First select: notification lookup, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]

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
			// First select: existing notification, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
			mockResults.insert = []

			const res = await app.request(jsonRequest('DELETE', `/api/notifications/${notification.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonDelete('/api/notifications/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/notifications/dismiss-all', () => {
		it('dismisses all pending/seen notifications and returns count', async () => {
			const n1 = buildNotification({ workspaceId: wsId, status: 'pending' })
			const n2 = buildNotification({ workspaceId: wsId, status: 'seen' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// First select: membership check
			mockResults.selectQueue = [[buildWorkspaceMember()]]
			mockResults.update = [{ id: n1.id }, { id: n2.id }]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('POST', '/api/notifications/dismiss-all', undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.dismissed).toBe(2)
		})

		it('returns 0 when no notifications to dismiss', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[buildWorkspaceMember()]]
			mockResults.update = []

			const res = await app.request(
				jsonRequest('POST', '/api/notifications/dismiss-all', undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.dismissed).toBe(0)
		})

		it('returns 403 when actor is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Membership check returns empty
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', '/api/notifications/dismiss-all', undefined, headers),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('Workspace membership enforcement', () => {
		it('GET /:id returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(jsonGet(`/api/notifications/${notification.id}`))
			expect(res.status).toBe(404)
		})

		it('PATCH /:id returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(
				jsonRequest('PATCH', `/api/notifications/${notification.id}`, { status: 'seen' }),
			)
			expect(res.status).toBe(404)
		})

		it('POST /:id/respond returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'pending' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond`,
					{ response: 'Approved' },
					headers,
				),
			)
			expect(res.status).toBe(404)
		})

		it('DELETE /:id returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(jsonDelete(`/api/notifications/${notification.id}`))
			expect(res.status).toBe(404)
		})
	})
})
