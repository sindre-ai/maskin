import { randomUUID } from 'node:crypto'
import { buildObject, buildSubscription } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

describe('Subscriptions Routes', () => {
	describe('POST /api/subscriptions', () => {
		it('returns 201 when subscribing to an existing object', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// Two selects: 1) verify object exists. autoSubscribe doesn't select.
			mockResults.selectQueue = [[{ id: obj.id }]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions',
					{ entity_type: 'object', entity_id: obj.id },
					headers,
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.subscribed).toBe(true)
		})

		it('returns 404 when the object does not exist', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// no select results queued → mock returns []

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions',
					{ entity_type: 'object', entity_id: randomUUID() },
					headers,
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for invalid entity_type', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions',
					{ entity_type: 'thread', entity_id: randomUUID() },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 for malformed UUID', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions',
					{ entity_type: 'object', entity_id: 'not-a-uuid' },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('DELETE /api/subscriptions', () => {
		it('returns 200 even when no subscription exists (idempotent)', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonRequest(
					'DELETE',
					'/api/subscriptions',
					{ entity_type: 'object', entity_id: randomUUID() },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.unsubscribed).toBe(true)
		})
	})

	describe('GET /api/subscriptions/subscribers', () => {
		it('returns the joined subscribers list', async () => {
			const entityId = randomUUID()
			const actorRow = { id: randomUUID(), type: 'human', name: 'Alice' }
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// 1) entity-in-workspace check, 2) subscribers join.
			mockResults.selectQueue = [[{ id: entityId }], [actorRow]]

			const res = await app.request(
				jsonGet(`/api/subscriptions/subscribers?entity_type=object&entity_id=${entityId}`, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.actors).toEqual([actorRow])
		})

		it('returns empty list when entity has no subscribers in this workspace', async () => {
			const entityId = randomUUID()
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// Entity exists, but no subscribers.
			mockResults.selectQueue = [[{ id: entityId }], []]

			const res = await app.request(
				jsonGet(`/api/subscriptions/subscribers?entity_type=object&entity_id=${entityId}`, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.actors).toEqual([])
		})

		it('returns 404 when the entity is not in this workspace', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// no selectQueue → entity-exists check returns [] → 404.

			const res = await app.request(
				jsonGet(
					`/api/subscriptions/subscribers?entity_type=object&entity_id=${randomUUID()}`,
					headers,
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when entity_id is missing', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonGet('/api/subscriptions/subscribers?entity_type=object', headers),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('POST /api/subscriptions/read', () => {
		it('returns 200 with a valid last_event_id', async () => {
			const entityId = randomUUID()
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// Entity-in-workspace check returns the row.
			mockResults.selectQueue = [[{ id: entityId }]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions/read',
					{ entity_type: 'object', entity_id: entityId, last_event_id: 42 },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.updated).toBe(true)
		})

		it('returns 404 when the entity is not in this workspace', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// no selectQueue → entity-exists check returns [] → 404.

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions/read',
					{ entity_type: 'object', entity_id: randomUUID(), last_event_id: 42 },
					headers,
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 for zero / non-positive last_event_id', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions/read',
					{ entity_type: 'object', entity_id: randomUUID(), last_event_id: 0 },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 for non-numeric last_event_id', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions/read',
					{ entity_type: 'object', entity_id: randomUUID(), last_event_id: 'abc' },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/subscriptions/unread', () => {
		it('returns empty list when nothing unread', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(jsonGet('/api/subscriptions/unread', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items).toEqual([])
		})

		it('hydrates the embedded object for object entity_type', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const sub = buildSubscription({ workspaceId: wsId, entityType: 'object', entityId: obj.id })
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// First select = aggregate join query → returns the grouped row.
			// Second select = inArray fetch for object summaries.
			mockResults.selectQueue = [
				[
					{
						entityType: 'object',
						entityId: obj.id,
						unreadCount: 3,
						mentionsYou: false,
						latestEventId: 100,
						latestActivityAt: new Date('2026-01-01T00:00:00Z'),
					},
				],
				[obj],
			]
			// Suppress unused-var lint by referencing the sub factory
			void sub

			const res = await app.request(jsonGet('/api/subscriptions/unread', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items).toHaveLength(1)
			expect(body.items[0].entity_id).toBe(obj.id)
			expect(body.items[0].unread_count).toBe(3)
			expect(body.items[0].mentions_you).toBe(false)
			expect(body.items[0].object?.id).toBe(obj.id)
		})

		it('surfaces mentions_you=true when the aggregate flag is set', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			mockResults.selectQueue = [
				[
					{
						entityType: 'object',
						entityId: obj.id,
						unreadCount: 1,
						mentionsYou: true,
						latestEventId: 200,
						latestActivityAt: new Date('2026-01-02T00:00:00Z'),
					},
				],
				[obj],
			]

			const res = await app.request(jsonGet('/api/subscriptions/unread', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items[0].mentions_you).toBe(true)
		})

		it('rejects unknown entity_type filter with 400', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonGet('/api/subscriptions/unread?entity_type=thread', headers),
			)

			expect(res.status).toBe(400)
		})
	})
})
