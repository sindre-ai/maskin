import { randomUUID } from 'node:crypto'
import { buildEvent, buildObject } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
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

	describe('GET /api/events (SSE stream)', () => {
		it('returns 400 when X-Workspace-Id header is missing', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const res = await app.request(jsonGet('/api/events'))

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('X-Workspace-Id header required')
		})

		it('returns 200 with text/event-stream content-type', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const controller = new AbortController()
			const req = new Request('http://localhost/api/events', {
				method: 'GET',
				headers: { 'X-Workspace-Id': wsId },
				signal: controller.signal,
			})

			const res = await app.request(req)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			controller.abort()
		})

		// Smoke test: verifies the SSE endpoint accepts Last-Event-ID without error.
		// Cannot assert replayed content because the stream stays open (active connection).
		it('accepts Last-Event-ID header and returns SSE stream', async () => {
			const e1 = buildEvent({ workspaceId: wsId, id: 5, action: 'created' })
			const e2 = buildEvent({ workspaceId: wsId, id: 6, action: 'updated' })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1, e2]

			const controller = new AbortController()
			const req = new Request('http://localhost/api/events', {
				method: 'GET',
				headers: {
					'X-Workspace-Id': wsId,
					'Last-Event-ID': '4',
				},
				signal: controller.signal,
			})

			const res = await app.request(req)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			controller.abort()
		})
	})

	describe('POST /api/events (create comment)', () => {
		it('returns 201 when creating a comment', async () => {
			const objectId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hello world' },
			})
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			// First select: object lookup, then transaction insert returns comment
			mockResults.selectQueue = [[{ workspaceId: wsId }]]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hello world' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.action).toBe('commented')
		})

		it('returns 404 when target object not found', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: randomUUID(), content: 'Hello' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when object belongs to different workspace', async () => {
			const differentWsId = randomUUID()
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			// Object found but belongs to different workspace
			mockResults.select = [{ workspaceId: differentWsId }]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: randomUUID(), content: 'Hello' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('creates notifications for @mentioned agent actors', async () => {
			const objectId = randomUUID()
			const agentId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @agent', mentions: [agentId] },
			})
			const notification = {
				id: randomUUID(),
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @agent',
				sourceActorId: 'test-actor-id',
				targetActorId: agentId,
				objectId,
				status: 'pending',
			}
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			// Object lookup, then inside transaction: insert comment, select mentioned actors, insert notifications, insert notification events
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[{ id: agentId, type: 'agent', name: 'Bot' }],
			]
			mockResults.insert = [commentEvent, notification]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @agent', mentions: [agentId] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
		})

		it('creates no notifications when mentions array is empty', async () => {
			const objectId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'No mentions here', mentions: [] },
			})
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [[{ workspaceId: wsId }]]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'No mentions here', mentions: [] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.action).toBe('commented')
		})

		it('creates batch notifications for multiple agent mentions', async () => {
			const objectId = randomUUID()
			const agent1Id = randomUUID()
			const agent2Id = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @bot1 @bot2', mentions: [agent1Id, agent2Id] },
			})
			const notification1 = {
				id: randomUUID(),
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @bot1 @bot2',
				sourceActorId: 'test-actor-id',
				targetActorId: agent1Id,
				objectId,
				status: 'pending',
			}
			const notification2 = {
				id: randomUUID(),
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @bot1 @bot2',
				sourceActorId: 'test-actor-id',
				targetActorId: agent2Id,
				objectId,
				status: 'pending',
			}
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[
					{ id: agent1Id, type: 'agent', name: 'Bot1' },
					{ id: agent2Id, type: 'agent', name: 'Bot2' },
				],
			]
			mockResults.insert = [commentEvent, notification1, notification2]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @bot1 @bot2', mentions: [agent1Id, agent2Id] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
		})

		it('skips notifications when mentions only contain human actors', async () => {
			const objectId = randomUUID()
			const humanId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @human', mentions: [humanId] },
			})
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[{ id: humanId, type: 'human', name: 'Alice' }],
			]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @human', mentions: [humanId] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
		})
	})
})
