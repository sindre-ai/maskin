import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, messages, sessions, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { evaluateAndRespond } from '../../services/conversation-responder'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: { createSession: ReturnType<typeof vi.fn> }
	}
}

function createConversationsApp(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	const sessionManager = { createSession: vi.fn().mockResolvedValue({ id: 'fake-session-id' }) }

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager)
		await next()
	})

	app.route('/api/conversations', conversationsRoutes)
	return { app, sessionManager }
}

async function addMember(workspaceId: string, actorId: string, role = 'member') {
	await db.insert(workspaceMembers).values({ workspaceId, actorId, role })
}

describe('Conversations Integration', () => {
	let ownerId: string
	let workspaceId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
	})

	describe('create + list + detail', () => {
		it('creates a conversation with participants and an initial message', async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app } = createConversationsApp(ownerId)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Launch plan', participant_actor_ids: [other.id], initial_message: 'hey team' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
			const body = (await res.json()) as {
				id: string
				title: string
				participants: Array<{ actorId: string }>
				unread_count: number
			}
			expect(body.title).toBe('Launch plan')
			expect(body.participants.map((p) => p.actorId).sort()).toEqual([ownerId, other.id].sort())

			const [row] = await db.select().from(conversations).where(eq(conversations.id, body.id))
			expect(row).toBeTruthy()
			const [msg] = await db.select().from(messages).where(eq(messages.conversationId, body.id))
			expect(msg?.content).toBe('hey team')
		})

		it('rejects a participant who is not a workspace member', async () => {
			const outsider = await insertActor(db, { type: 'human' })
			const { app } = createConversationsApp(ownerId)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Nope', participant_actor_ids: [outsider.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(400)
		})

		it('lists conversations for the caller with unread counts, excluding non-participants', async () => {
			const other = await insertActor(db, { type: 'human' })
			const stranger = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			await addMember(workspaceId, stranger.id)

			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Shared thread', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			// Owner posts a message — other participant should see it as unread.
			await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'first message' },
					{ 'x-workspace-id': workspaceId },
				),
			)

			const { app: otherApp } = createConversationsApp(other.id)
			const listRes = await otherApp.request(
				jsonGet('/api/conversations', { 'x-workspace-id': workspaceId }),
			)
			expect(listRes.status).toBe(200)
			const list = (await listRes.json()) as {
				conversations: Array<{ id: string; unread_count: number; snippet: string | null }>
			}
			expect(list.conversations).toHaveLength(1)
			expect(list.conversations[0]?.id).toBe(conversation.id)
			expect(list.conversations[0]?.unread_count).toBe(1)
			expect(list.conversations[0]?.snippet).toBe('first message')

			// Stranger (workspace member, not a conversation participant) sees nothing.
			const { app: strangerApp } = createConversationsApp(stranger.id)
			const strangerList = await strangerApp.request(
				jsonGet('/api/conversations', { 'x-workspace-id': workspaceId }),
			)
			const strangerBody = (await strangerList.json()) as { conversations: unknown[] }
			expect(strangerBody.conversations).toHaveLength(0)

			// And a 404 on direct detail access.
			const strangerDetail = await strangerApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			expect(strangerDetail.status).toBe(404)
		})

		it('marking read clears unread_count and never regresses on an older value', async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Thread', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const m1 = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'one' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const msg1 = (await m1.json()) as { id: number }
			const m2 = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'two' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const msg2 = (await m2.json()) as { id: number }

			const { app: otherApp } = createConversationsApp(other.id)
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: msg2.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const detail1 = await otherApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody1 = (await detail1.json()) as {
				unread_count: number
				last_read_message_id: number
			}
			expect(detailBody1.unread_count).toBe(0)
			expect(detailBody1.last_read_message_id).toBe(msg2.id)

			// Regressing to an earlier message id must not move last_read_message_id backwards.
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: msg1.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const detail2 = await otherApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody2 = (await detail2.json()) as { last_read_message_id: number }
			expect(detailBody2.last_read_message_id).toBe(msg2.id)
		})
	})

	describe('participants', () => {
		it('re-adding a removed participant preserves their pinned/archived state', async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Sticky prefs', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const { app: otherApp } = createConversationsApp(other.id)
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ pinned: true },
					{ 'x-workspace-id': workspaceId },
				),
			)

			// Owner removes, then re-adds the other participant.
			await ownerApp.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${other.id}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			const removedList = await otherApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			expect(removedList.status).toBe(404)

			await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/participants`,
					{ actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const detail = await otherApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			expect(detail.status).toBe(200)
			const detailBody = (await detail.json()) as { pinned: boolean }
			expect(detailBody.pinned).toBe(true)
		})
	})

	describe('messages.session_id', () => {
		it('rejects two messages claiming the same session_id (unique constraint)', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const session = await insertSession(db, workspaceId, agent.id, ownerId)

			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'With agent', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			// Stamp session.config.conversation so the ownership check in the route passes.
			await db
				.update(sessions)
				.set({
					config: { conversation: { conversation_id: conversation.id, message_id: 1 } },
				})
				.where(eq(sessions.id, session.id))

			const { app: agentApp } = createConversationsApp(agent.id, 'agent')
			const first = await agentApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'agent reply', session_id: session.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(first.status).toBe(201)
			const firstBody = (await first.json()) as { sessionId: string | null }
			expect(firstBody.sessionId).toBe(session.id)

			// A second message row directly claiming the same session_id must violate
			// the DB's unique constraint — this is the idempotency guard for the MCP
			// tool, so it must be enforced at the DB layer, not just app logic.
			await expect(
				db.insert(messages).values({
					conversationId: conversation.id,
					actorId: agent.id,
					content: 'duplicate claim',
					sessionId: session.id,
				}),
			).rejects.toThrow()
		})
	})

	describe('conversation-responder', () => {
		it('the mention fast-path spawns a session without needing LLM credentials', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp, sessionManager } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Mention test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: `hey <@${agent.id}>`, metadata: { mentions: [agent.id] } },
					{ 'x-workspace-id': workspaceId },
				),
			)

			// evaluateAndRespond is fire-and-forget from the route (not awaited)
			// — give the microtask queue a turn before asserting.
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession.mock.calls[0]?.[1]).toMatchObject({ actorId: agent.id })
		})

		it('skips every agent once the consecutive-agent-reply cap is reached, even a @mentioned one', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			const otherAgent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			await addMember(workspaceId, otherAgent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Runaway guard', participant_actor_ids: [agent.id, otherAgent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			// Seed 5 consecutive agent-authored messages directly (bypassing the
			// responder, which has no real LLM credentials in this test env),
			// simulating an agent-to-agent chain already in progress. The
			// triggering message below is itself agent-authored (the 6th in a
			// row) and @mentions the other agent — this is the runaway
			// ping-pong shape the cap exists to stop. A human message would
			// reset the tail count to zero, which is correct and NOT what this
			// test is checking.
			for (let i = 0; i < 5; i++) {
				await db.insert(messages).values({
					conversationId: conversation.id,
					actorId: agent.id,
					content: `agent turn ${i}`,
				})
			}

			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: otherAgent.id,
					content: `still there? <@${agent.id}>`,
					metadata: { mentions: [agent.id] },
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = { createSession: vi.fn().mockResolvedValue({ id: 'x' }) }
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})
})
