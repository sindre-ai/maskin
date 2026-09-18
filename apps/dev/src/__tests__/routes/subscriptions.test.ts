import { randomUUID } from 'node:crypto'
import { buildObject } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

describe('Subscriptions Routes', () => {
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

	describe('POST /api/subscriptions/unread', () => {
		it('returns 200 when marking an existing object unread', async () => {
			const entityId = randomUUID()
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// Entity-in-workspace check returns the row; delete has no result.
			mockResults.selectQueue = [[{ id: entityId }]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/subscriptions/unread',
					{ entity_type: 'object', entity_id: entityId },
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
					'/api/subscriptions/unread',
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
					'/api/subscriptions/unread',
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
					'/api/subscriptions/unread',
					{ entity_type: 'object', entity_id: 'not-a-uuid' },
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
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// Aggregate over `events` → the grouped row; then the inArray fetch
			// for object summaries.
			mockResults.selectQueue = [
				// 1st select = the workspaces lookup that resolves `created_by` for
				// the onboarding carve-out; the aggregate follows it.
				[{ createdBy: null }],
				[
					{
						entityType: 'object',
						entityId: obj.id,
						unreadCount: 3,
						mentioningUnreadCount: 0,
						latestEventId: 100,
						latestActivityAt: new Date('2026-01-01T00:00:00Z'),
					},
				],
				[obj],
			]
			const res = await app.request(jsonGet('/api/subscriptions/unread', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items).toHaveLength(1)
			expect(body.items[0].entity_id).toBe(obj.id)
			expect(body.items[0].unread_count).toBe(3)
			expect(body.items[0].mentioning_unread_count).toBe(0)
			expect(body.items[0]).not.toHaveProperty('mentions_you')
			expect(body.items[0].object?.id).toBe(obj.id)
		})

		it('surfaces the per-event mentioning count when at least one unread event mentions the actor', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			mockResults.selectQueue = [
				// 1st select = the workspaces lookup that resolves `created_by` for
				// the onboarding carve-out; the aggregate follows it.
				[{ createdBy: null }],
				[
					{
						entityType: 'object',
						entityId: obj.id,
						unreadCount: 10,
						mentioningUnreadCount: 1,
						maxUnreadAttention: 4,
						latestEventId: 200,
						latestActivityAt: new Date('2026-01-02T00:00:00Z'),
					},
				],
				[obj],
			]

			const res = await app.request(jsonGet('/api/subscriptions/unread', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			// One mentioning event among ten unread events surfaces as the literal
			// per-event count, not as a "the whole object is mentioned" boolean.
			expect(body.items[0].mentioning_unread_count).toBe(1)
			expect(body.items[0].unread_count).toBe(10)
			expect(body.items[0].max_unread_attention).toBe(4)
			expect(body.items[0]).not.toHaveProperty('mentions_you')
		})

		it('returns null max_unread_attention when no unread comment carries a score', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			mockResults.selectQueue = [
				// 1st select = the workspaces lookup that resolves `created_by` for
				// the onboarding carve-out; the aggregate follows it.
				[{ createdBy: null }],
				[
					{
						entityType: 'object',
						entityId: obj.id,
						unreadCount: 1,
						mentioningUnreadCount: 1,
						maxUnreadAttention: null,
						latestEventId: 100,
						latestActivityAt: new Date('2026-01-01T00:00:00Z'),
					},
				],
				[obj],
			]

			const res = await app.request(jsonGet('/api/subscriptions/unread', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items[0].max_unread_attention).toBeNull()
		})

		it('rejects unknown entity_type filter with 400', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonGet('/api/subscriptions/unread?entity_type=thread', headers),
			)

			expect(res.status).toBe(400)
		})

		it('accepts include_recently_read=true and still hydrates object rows', async () => {
			const obj = buildObject({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(subscriptionsRoutes, '/api/subscriptions')
			// A recently-read card comes back with unread_count = 0 but is still
			// present in the feed with a non-null latest_activity_at.
			mockResults.selectQueue = [
				// 1st select = the workspaces lookup that resolves `created_by` for
				// the onboarding carve-out; the aggregate follows it.
				[{ createdBy: null }],
				[
					{
						entityType: 'object',
						entityId: obj.id,
						unreadCount: 0,
						mentioningUnreadCount: 0,
						latestEventId: 100,
						latestActivityAt: new Date('2026-01-01T00:00:00Z'),
					},
				],
				[obj],
			]

			const res = await app.request(
				jsonGet('/api/subscriptions/unread?include_recently_read=true', headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items).toHaveLength(1)
			expect(body.items[0].unread_count).toBe(0)
			expect(body.items[0].latest_activity_at).toBe('2026-01-01T00:00:00.000Z')
			expect(body.items[0].object?.id).toBe(obj.id)
		})

		it('rejects a non-boolean include_recently_read value with 400', async () => {
			const { app } = createTestApp(subscriptionsRoutes, '/api/subscriptions')

			const res = await app.request(
				jsonGet('/api/subscriptions/unread?include_recently_read=yes', headers),
			)

			expect(res.status).toBe(400)
		})
	})
})
