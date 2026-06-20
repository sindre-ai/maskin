import { randomUUID } from 'node:crypto'
import { events } from '@maskin/db/schema'
import { desc } from 'drizzle-orm'
import { buildEvent, buildObject, buildSubscription, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = 'test-actor-id'
const headers = { 'x-workspace-id': wsId }

function buildConversation(overrides: Record<string, unknown> = {}) {
	return buildObject({
		workspaceId: wsId,
		type: 'conversation',
		title: null,
		content: null,
		status: 'active',
		metadata: {},
		createdBy: actorId,
		...overrides,
	})
}

describe('Conversations Routes', () => {
	describe('POST /api/conversations', () => {
		it('creates a conversation object, logs the event, seats the caller', async () => {
			const conversation = buildConversation()
			const { app, mockResults, calls } = createTestApp(conversationsRoutes, '/api/conversations')
			// objects insert, events insert, author subscription insert
			mockResults.insertQueue = [[conversation], [], []]

			const res = await app.request(
				jsonRequest('POST', '/api/conversations', { title: 'Stand-up' }, headers),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(conversation.id)

			// Conversation object insert — type='conversation', title carried, caller is createdBy.
			const objectInsert = calls.inserts[0] as {
				type: string
				title: string | null
				status: string
				createdBy: string
				workspaceId: string
			}
			expect(objectInsert.type).toBe('conversation')
			expect(objectInsert.title).toBe('Stand-up')
			expect(objectInsert.status).toBe('active')
			expect(objectInsert.createdBy).toBe(actorId)
			expect(objectInsert.workspaceId).toBe(wsId)

			// Event row — action='created' against the new conversation object.
			const eventInsert = calls.inserts[1] as {
				action: string
				entityType: string
				entityId: string
				actorId: string
			}
			expect(eventInsert.action).toBe('created')
			expect(eventInsert.entityType).toBe('object')
			expect(eventInsert.entityId).toBe(conversation.id)
			expect(eventInsert.actorId).toBe(actorId)

			// Author auto-subscribe — caller seated as 'author' on the conversation.
			const authorSubInsert = calls.inserts[2] as {
				actorId: string
				entityType: string
				entityId: string
				source: string
			}
			expect(authorSubInsert.actorId).toBe(actorId)
			expect(authorSubInsert.entityType).toBe('object')
			expect(authorSubInsert.entityId).toBe(conversation.id)
			expect(authorSubInsert.source).toBe('author')
		})

		it('stores kind + auto_join in objects.metadata per T2 documented shape', async () => {
			const conversation = buildConversation()
			const autoJoinActorId = randomUUID()
			const { app, mockResults, calls } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.insertQueue = [[conversation], [], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Room', kind: 'room', auto_join: [autoJoinActorId] },
					headers,
				),
			)

			expect(res.status).toBe(201)
			const objectInsert = calls.inserts[0] as { metadata: Record<string, unknown> }
			expect(objectInsert.metadata).toMatchObject({
				kind: 'room',
				auto_join: [autoJoinActorId],
			})
		})

		it('seats explicitly named participants as manual subscriptions and dedupes caller', async () => {
			const callerUuid = randomUUID()
			const co = randomUUID()
			const conversation = buildConversation({ createdBy: callerUuid })
			const { app, mockResults, calls } = createTestApp(
				conversationsRoutes,
				'/api/conversations',
				callerUuid,
			)
			// object insert, event insert, author subscription, manual subscription for `co`
			mockResults.insertQueue = [[conversation], [], [], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ participant_actor_ids: [callerUuid, co] },
					headers,
				),
			)

			expect(res.status).toBe(201)

			// Three subscription inserts in total: caller's auto-author insert,
			// then a single 'manual' insert for the deduped co-participant. The
			// caller is filtered out of the manual loop.
			const authorSub = calls.inserts[2] as { actorId: string; source: string }
			expect(authorSub.actorId).toBe(callerUuid)
			expect(authorSub.source).toBe('author')

			const manualSub = calls.inserts[3] as { actorId: string; source: string }
			expect(manualSub.actorId).toBe(co)
			expect(manualSub.source).toBe('manual')

			// No 4th subscription insert — caller was deduped out.
			expect(calls.inserts.length).toBe(4)
		})

		it('rejects bodies with unparseable metadata', async () => {
			const { app } = createTestApp(conversationsRoutes, '/api/conversations')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ metadata: { broken: { nested: 'object' } } },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/conversations', () => {
		it('returns conversation objects the caller is subscribed to', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.select = [conversation]

			const res = await app.request(jsonGet('/api/conversations', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(conversation.id)
		})

		it('returns an empty list when the caller has no subscriptions', async () => {
			const { app } = createTestApp(conversationsRoutes, '/api/conversations')

			const res = await app.request(jsonGet('/api/conversations', headers))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		})
	})

	describe('GET /api/conversations/:id', () => {
		it('returns 200 when the caller is a workspace member and subscribed', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			// conversation object lookup, workspace member check, subscription check
			mockResults.selectQueue = [
				[conversation],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
			]

			const res = await app.request(jsonGet(`/api/conversations/${conversation.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(conversation.id)
		})

		it('returns 404 when the conversation object does not exist', async () => {
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [[]]

			const res = await app.request(jsonGet(`/api/conversations/${randomUUID()}`))

			expect(res.status).toBe(404)
		})

		it('returns 404 when the caller is in the workspace but not subscribed', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[conversation],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[], // no subscription row
			]

			const res = await app.request(jsonGet(`/api/conversations/${conversation.id}`))

			expect(res.status).toBe(404)
		})

		it('returns 404 when the caller is not a workspace member', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [[conversation], []]

			const res = await app.request(jsonGet(`/api/conversations/${conversation.id}`))

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/conversations/:id/messages', () => {
		it('appends a commented event and auto-subscribes the commenter', async () => {
			const conversation = buildConversation()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				actorId,
				action: 'commented',
				entityType: 'object',
				entityId: conversation.id,
				data: { content: 'hi', mentions: undefined, parentEventId: undefined },
			})
			const { app, mockResults, calls } = createSessionTestApp(
				conversationsRoutes,
				'/api/conversations',
			)
			// conversation lookup, workspace member, subscription check
			mockResults.selectQueue = [
				[{ id: conversation.id, workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
			]
			// event insert (from appendCommentEvent), commenter subscription insert
			mockResults.insertQueue = [[commentEvent], []]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/messages`, {
					content: 'hi',
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(commentEvent.id)
			expect(body.conversationId).toBe(conversation.id)
			expect(body.actorId).toBe(actorId)
			expect(body.content).toBe('hi')

			// Event insert — action='commented' against the conversation object.
			const eventInsert = calls.inserts[0] as {
				action: string
				entityType: string
				entityId: string
				data: { content: string }
			}
			expect(eventInsert.action).toBe('commented')
			expect(eventInsert.entityType).toBe('object')
			expect(eventInsert.entityId).toBe(conversation.id)
			expect(eventInsert.data.content).toBe('hi')

			// Commenter auto-subscribe.
			const subInsert = calls.inserts[1] as {
				actorId: string
				entityType: string
				entityId: string
				source: string
			}
			expect(subInsert.actorId).toBe(actorId)
			expect(subInsert.entityType).toBe('object')
			expect(subInsert.entityId).toBe(conversation.id)
			expect(subInsert.source).toBe('commenter')
		})

		it('returns 404 when the caller is not a subscribed participant', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createSessionTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ id: conversation.id, workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/messages`, {
					content: 'hi',
				}),
			)

			expect(res.status).toBe(404)
		})

		it('persists attachment_file_ids when all files belong to the conversation workspace', async () => {
			const conversation = buildConversation()
			const fileA = randomUUID()
			const fileB = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				actorId,
				action: 'commented',
				entityType: 'object',
				entityId: conversation.id,
				data: { content: 'see attached', attachmentFileIds: [fileA, fileB] },
			})
			const { app, mockResults, calls } = createSessionTestApp(
				conversationsRoutes,
				'/api/conversations',
			)
			mockResults.selectQueue = [
				[{ id: conversation.id, workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
				[{ id: fileA }, { id: fileB }],
			]
			mockResults.insertQueue = [[commentEvent], []]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/messages`, {
					content: 'see attached',
					attachment_file_ids: [fileA, fileB],
				}),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { data: { attachmentFileIds?: string[] } }
			expect(inserted.data.attachmentFileIds).toEqual([fileA, fileB])
		})

		it('rejects attachment_file_ids that do not belong to the conversation workspace', async () => {
			const conversation = buildConversation()
			const fileA = randomUUID()
			const fileB = randomUUID()
			const { app, mockResults, calls, sessionManager } = createSessionTestApp(
				conversationsRoutes,
				'/api/conversations',
			)
			mockResults.selectQueue = [
				[{ id: conversation.id, workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
				[{ id: fileA }],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/messages`, {
					content: 'see attached',
					attachment_file_ids: [fileA, fileB],
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('attached files')
			expect(calls.inserts).toEqual([])
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('rejects empty content', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createSessionTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ id: conversation.id, workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/messages`, {
					content: '',
				}),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/conversations/:id/messages', () => {
		it('returns commented events filtered by the conversation object id', async () => {
			const conversation = buildConversation()
			const commentEvent = buildEvent({
				action: 'commented',
				entityType: 'object',
				entityId: conversation.id,
				data: { content: 'hi' },
			})
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
				[commentEvent],
			]

			const res = await app.request(jsonGet(`/api/conversations/${conversation.id}/messages`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(commentEvent.id)
			expect(body[0].content).toBe('hi')
			expect(body[0].conversationId).toBe(conversation.id)
		})

		it('returns 404 when the caller is not subscribed', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[],
			]

			const res = await app.request(jsonGet(`/api/conversations/${conversation.id}/messages`))

			expect(res.status).toBe(404)
		})

		it('pages backwards from before_id and returns the older window in ASC order', async () => {
			const conversation = buildConversation()
			// The DB query the route should issue: `lt(events.id, before_id)` +
			// `orderBy(desc(events.id))` + `limit(50)`. Simulate the result the DB
			// would hand back for that query — the 50 events immediately older than
			// id=1000, in DESC order [999, 998, …, 950]. The handler is responsible
			// for reversing that into ASC chronological order before responding.
			const olderWindowDesc = Array.from({ length: 50 }, (_, idx) =>
				buildEvent({
					id: 999 - idx,
					action: 'commented',
					entityType: 'object',
					entityId: conversation.id,
					data: { content: `msg ${999 - idx}` },
				}),
			)
			const { app, mockResults, calls } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
				olderWindowDesc,
			]

			const res = await app.request(
				jsonGet(`/api/conversations/${conversation.id}/messages?before_id=1000&limit=50`),
			)

			expect(res.status).toBe(200)
			const body = (await res.json()) as Array<{ id: number; content: string }>
			expect(body).toHaveLength(50)
			// The window is the 50 events *immediately older* than 1000, not the
			// oldest 50 events of the whole conversation (the original asc/lt bug).
			expect(body[0].id).toBe(950)
			expect(body[49].id).toBe(999)
			// Returned in ASC chronological order so callers can render top-to-bottom
			// without a second sort.
			const ids = body.map((m) => m.id)
			expect(ids).toEqual([...ids].sort((a, b) => a - b))
			// Pin the sort direction at the query level: ASC would silently regress
			// the window even if the post-query reverse stayed in place.
			const messagesOrderBy = calls.orderBys.at(-1)
			expect(messagesOrderBy).toEqual(desc(events.id))
		})
	})

	describe('POST /api/conversations/:id/participants', () => {
		it('seats a new participant as a manual subscription', async () => {
			const conversation = buildConversation()
			const newActorId = randomUUID()
			const newSubscription = buildSubscription({
				actorId: newActorId,
				entityId: conversation.id,
				source: 'manual',
			})
			const { app, mockResults, calls } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
				[newSubscription], // lookup after insert
			]
			mockResults.insertQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/participants`, {
					actor_id: newActorId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.actorId).toBe(newActorId)
			expect(body.source).toBe('manual')
			expect(body.conversationId).toBe(conversation.id)

			const subInsert = calls.inserts[0] as {
				actorId: string
				entityType: string
				entityId: string
				source: string
			}
			expect(subInsert.actorId).toBe(newActorId)
			expect(subInsert.entityType).toBe('object')
			expect(subInsert.entityId).toBe(conversation.id)
			expect(subInsert.source).toBe('manual')
		})

		it('returns 404 when the caller is not subscribed', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/conversations/${conversation.id}/participants`, {
					actor_id: randomUUID(),
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/conversations/:id/participants/:actorId', () => {
		it('removes a subscription row and returns 200', async () => {
			const conversation = buildConversation()
			const target = randomUUID()
			const removed = buildSubscription({
				actorId: target,
				entityId: conversation.id,
				source: 'manual',
			})
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
			]
			mockResults.delete = [removed]

			const res = await app.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${target}`),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.actorId).toBe(target)
			expect(body.conversationId).toBe(conversation.id)
		})

		it('returns 404 when the target subscription does not exist', async () => {
			const conversation = buildConversation()
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[buildSubscription({ actorId, entityId: conversation.id })],
			]
			mockResults.delete = []

			const res = await app.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${randomUUID()}`),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('GET /api/conversations/:id/participants', () => {
		it('lists subscription rows for the conversation object', async () => {
			const conversation = buildConversation()
			const sub = buildSubscription({ actorId, entityId: conversation.id, source: 'author' })
			const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
			mockResults.selectQueue = [
				[{ workspaceId: conversation.workspaceId }],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
				[sub],
				[sub],
			]

			const res = await app.request(jsonGet(`/api/conversations/${conversation.id}/participants`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].actorId).toBe(actorId)
			expect(body[0].source).toBe('author')
			expect(body[0].conversationId).toBe(conversation.id)
		})
	})
})
