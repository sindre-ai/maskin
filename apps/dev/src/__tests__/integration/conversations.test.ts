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
		sessionManager: {
			createSession: ReturnType<typeof vi.fn>
			findActiveConversationSession: ReturnType<typeof vi.fn>
			writeInput: ReturnType<typeof vi.fn>
		}
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

	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: 'fake-session-id' }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}

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
		it('allows multiple messages to share the same session_id (interactive sessions are reused across replies)', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const session = await insertSession(db, workspaceId, agent.id, ownerId, { interactive: true })

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

			// A second message row claiming the same session_id must now succeed —
			// one interactive session is reused across many replies over its
			// lifetime, so sessionId is no longer unique (see 0056_messages_session_id_drop_uniq.sql).
			const [second] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: agent.id,
					content: 'second reply, same session',
					sessionId: session.id,
				})
				.returning()
			expect(second?.sessionId).toBe(session.id)
		})
	})

	describe('sessions_conversation_actor_active_uniq', () => {
		it('rejects a second active interactive session for the same (conversation, agent) pair', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Double spawn guard', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			await insertSession(db, workspaceId, agent.id, ownerId, {
				interactive: true,
				status: 'running',
				conversationId: conversation.id,
			})

			await expect(
				insertSession(db, workspaceId, agent.id, ownerId, {
					interactive: true,
					status: 'starting',
					conversationId: conversation.id,
				}),
			).rejects.toThrow()
		})

		it('allows a new active session once the previous one for that pair reached a terminal status', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Dead session reuse', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			await insertSession(db, workspaceId, agent.id, ownerId, {
				interactive: true,
				status: 'timeout',
				conversationId: conversation.id,
			})

			const fresh = await insertSession(db, workspaceId, agent.id, ownerId, {
				interactive: true,
				status: 'running',
				conversationId: conversation.id,
			})
			expect(fresh?.status).toBe('running')
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

		it('spawns a session for a direct 1:1 message with no mention and no chat credentials configured', async () => {
			// Regression test: a fresh 1:1 chat with an agent whose only LLM
			// route is Claude OAuth (not chat-callable via resolveChatCredentials)
			// used to silently never spawn a session for a plain, non-mentioning
			// first message — checkRelevance failed closed and nothing surfaced
			// it. Direct conversations now skip the relevance heuristic entirely.
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Direct no-mention test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'hi' })
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'new-session-id' }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession.mock.calls[0]?.[1]).toMatchObject({ actorId: agent.id })
		})

		it('fails open in a group chat with no mention and no chat credentials configured', async () => {
			// The relevance heuristic itself being uncallable (no chat-callable
			// credential) is not proof the agent has no credentials at all — the
			// real session launch supports Claude OAuth. So a missing heuristic
			// credential should default to responding, not silently declining.
			const agent = await insertActor(db, { type: 'agent' })
			const otherAgent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			await addMember(workspaceId, otherAgent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{
						title: 'Group no-credential test',
						participant_actor_ids: [agent.id, otherAgent.id],
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: ownerId,
					content: 'just chatting, no mention here',
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'x' }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
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

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'x' }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
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

		it('reuses an existing running interactive session via writeInput instead of spawning', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Reuse test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: ownerId,
					content: `hey <@${agent.id}>`,
					metadata: { mentions: [agent.id] },
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'should-not-be-used' }),
				findActiveConversationSession: vi.fn().mockResolvedValue({ id: 'existing-session-id' }),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.writeInput).toHaveBeenCalledTimes(1)
			expect(sessionManager.writeInput.mock.calls[0]?.[0]).toBe('existing-session-id')
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('spawns a fresh interactive session with inlined history when none is running', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Fresh spawn test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			await db.insert(messages).values({
				conversationId: conversation.id,
				actorId: ownerId,
				content: 'earlier context message',
			})
			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: ownerId,
					content: `hey <@${agent.id}>`,
					metadata: { mentions: [agent.id] },
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'new-session-id' }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			const [, params] = sessionManager.createSession.mock.calls[0] as [
				string,
				Record<string, unknown>,
			]
			expect(params).toMatchObject({
				actorId: agent.id,
				config: { interactive: true, conversation: { conversation_id: conversation.id } },
			})
			expect(params.actionPrompt).toContain('earlier context message')
			expect(params.actionPrompt).toContain(`hey <@${agent.id}>`)
		})

		it('falls back to spawning fresh when writeInput to the existing session fails', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Dead session fallback', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: ownerId,
					content: `hey <@${agent.id}>`,
					metadata: { mentions: [agent.id] },
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'new-session-id' }),
				findActiveConversationSession: vi
					.fn()
					.mockResolvedValue({ id: 'dead-session-id', workspaceId }),
				writeInput: vi.fn().mockRejectedValue(new Error('container gone')),
				markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
			}
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.writeInput).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession.mock.calls[0]?.[1]).toMatchObject({ actorId: agent.id })
			// Regression: the dead session must be marked failed so it stops
			// satisfying sessions_conversation_actor_active_uniq — otherwise the
			// fresh createSession above collides with its own zombie on every
			// subsequent message (see the race-recovery test below).
			expect(sessionManager.markSessionFailedAfterContainerLoss).toHaveBeenCalledWith(
				'dead-session-id',
				workspaceId,
			)
		})

		it('marks the race-winner session failed too when joining it via writeInput also fails', async () => {
			// Covers the second half of the same bug: spawnOrJoinConversationSession's
			// unique-constraint race-recovery path re-looks-up the "winner" and tries
			// writeInput on it. If that winner is itself dead (the same self-heal gap
			// as the primary reuse path), it used to be logged and dropped forever,
			// permanently wedging sessions_conversation_actor_active_uniq for this
			// (conversation, agent) pair until the 2h timeout reaper caught it.
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Race-winner also dead', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: ownerId,
					content: `hey <@${agent.id}>`,
					metadata: { mentions: [agent.id] },
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const raceViolation = Object.assign(new Error('duplicate key value'), {
				code: '23505',
				constraint_name: 'sessions_conversation_actor_active_uniq',
			})
			const sessionManager = {
				// No existing session visible on the first lookup — goes straight to
				// spawnOrJoinConversationSession, whose createSession hits the race
				// violation simulated above.
				findActiveConversationSession: vi
					.fn()
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce({ id: 'winner-session-id', workspaceId }),
				createSession: vi.fn().mockRejectedValue(raceViolation),
				writeInput: vi.fn().mockRejectedValue(new Error('container gone')),
				markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
			}
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.writeInput).toHaveBeenCalledWith('winner-session-id', expect.anything())
			expect(sessionManager.markSessionFailedAfterContainerLoss).toHaveBeenCalledWith(
				'winner-session-id',
				workspaceId,
			)
		})
	})
})
