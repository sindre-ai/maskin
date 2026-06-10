import { randomUUID } from 'node:crypto'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = 'test-actor-id'

function buildConversation(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		workspaceId: wsId,
		title: 'Test conversation',
		type: 'dm',
		lastMessagePreview: null,
		lastActivityAt: null,
		createdAt: new Date(),
		...overrides,
	}
}

function buildMessage(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		conversationId: randomUUID(),
		actorId: randomUUID(),
		content: 'Hello',
		createdAt: new Date(),
		...overrides,
	}
}

function buildParticipant(overrides?: Record<string, unknown>) {
	return {
		conversationId: randomUUID(),
		actorId: randomUUID(),
		unreadCount: 0,
		lastReadAt: null,
		...overrides,
	}
}

describe('Conversations Routes', () => {
	describe('GET /api/conversations', () => {
		it('returns 200 with list of conversations the caller participates in', async () => {
			const conv = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			// The handler builds 3 subquery objects (participantCount, unreadCount, actorConversationIds)
			// before executing 2 real queries (conversations, then participant actors).
			// Each db.select() call shifts one entry off the queue.
			mockResults.selectQueue = [
				[], // participantCountSubquery builder
				[], // unreadCountSubquery builder
				[], // actorConversationIds builder
				[{ ...conv, participantCount: 2, unreadCount: 0 }], // main conversations query
				[], // participant actors query
			]

			const res = await app.request(jsonGet('/api/conversations', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
			expect(body).toHaveLength(1)
		})

		it('returns empty array when caller is not a participant in any conversation', async () => {
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			// 3 subquery builders + 1 main query returning empty (no participant match)
			mockResults.selectQueue = [[], [], [], []]

			const res = await app.request(jsonGet('/api/conversations', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(0)
		})
	})

	describe('POST /api/conversations', () => {
		it('creates a conversation and returns 201', async () => {
			const conv = buildConversation({ type: 'room', title: 'Team room' })
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations', actorId)
			mockResults.insert = [conv]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{
						title: 'Team room',
						type: 'room',
						participant_actor_ids: [randomUUID()],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.type).toBe('room')
			expect(body.title).toBe('Team room')
		})

		it('returns 400 for invalid type', async () => {
			const { app } = createTestApp(conversationsRoutes, '/api/conversations')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ type: 'invalid', participant_actor_ids: [randomUUID()] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when participant_actor_ids is empty', async () => {
			const { app } = createTestApp(conversationsRoutes, '/api/conversations')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ type: 'dm', participant_actor_ids: [] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/conversations/:id/messages', () => {
		it('returns 200 with paginated messages', async () => {
			const convId = randomUUID()
			const conv = buildConversation({ id: convId })
			const msg = buildMessage({ conversationId: convId })
			const participant = buildParticipant({ conversationId: convId, actorId })
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations', actorId)
			mockResults.selectQueue = [[conv], [participant], [msg], [{ cnt: 1 }]]

			const res = await app.request(
				jsonGet(`/api/conversations/${convId}/messages`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body.data)).toBe(true)
			expect(typeof body.total).toBe('number')
		})

		it('returns 403 when caller is not a participant', async () => {
			const convId = randomUUID()
			const conv = buildConversation({ id: convId })
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations', actorId)
			mockResults.selectQueue = [[conv], []]

			const res = await app.request(
				jsonGet(`/api/conversations/${convId}/messages`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when conversation not found', async () => {
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.select = []

			const res = await app.request(
				jsonGet(`/api/conversations/${randomUUID()}/messages`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('accepts limit and offset query params', async () => {
			const convId = randomUUID()
			const conv = buildConversation({ id: convId })
			const participant = buildParticipant({ conversationId: convId, actorId })
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations', actorId)
			mockResults.selectQueue = [[conv], [participant], [], [{ cnt: 0 }]]

			const res = await app.request(
				jsonGet(`/api/conversations/${convId}/messages?limit=10&offset=20`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})
	})

	describe('POST /api/conversations/:id/participants', () => {
		it('adds a participant and returns 201', async () => {
			const convId = randomUUID()
			const conv = buildConversation({ id: convId })
			const newActorId = randomUUID()
			const participant = buildParticipant({ conversationId: convId, actorId: newActorId })
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [[conv], []]
			mockResults.insert = [participant]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${convId}/participants`,
					{ actor_id: newActorId },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.actorId).toBe(newActorId)
		})

		it('returns 404 when conversation not found', async () => {
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.select = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${randomUUID()}/participants`,
					{ actor_id: randomUUID() },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 409 when actor is already a participant', async () => {
			const convId = randomUUID()
			const existingActorId = randomUUID()
			const conv = buildConversation({ id: convId })
			const existingParticipant = buildParticipant({
				conversationId: convId,
				actorId: existingActorId,
			})
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [[conv], [existingParticipant]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${convId}/participants`,
					{ actor_id: existingActorId },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(409)
		})

		it('returns 400 for invalid actor_id', async () => {
			const { app } = createTestApp(conversationsRoutes, '/api/conversations')

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${randomUUID()}/participants`,
					{ actor_id: 'not-a-uuid' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})
})
