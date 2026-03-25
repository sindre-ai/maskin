import { buildEvent } from '../factories'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: eventsRoutes } = await import('../../routes/events')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Events Routes', () => {
	describe('GET /api/events/history', () => {
		it('returns 200 with list of events', async () => {
			const e1 = buildEvent({ workspaceId: wsId })
			const e2 = buildEvent({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1, e2]

			const res = await app.request(jsonGet('/api/events/history', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 200 with empty list when no events', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const res = await app.request(jsonGet('/api/events/history', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(0)
		})

		it('accepts filter query parameters', async () => {
			const e1 = buildEvent({ workspaceId: wsId, entityType: 'task', action: 'created' })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1]

			const res = await app.request(
				jsonGet('/api/events/history?entity_type=task&action=created&limit=10', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
		})
	})
})
