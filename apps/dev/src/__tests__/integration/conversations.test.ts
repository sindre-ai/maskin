import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversationPendingTurns,
	conversations,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	CREDENTIAL_NAME_MAX_LENGTH,
	checkCredentialName,
	manualRedactionMarker,
} from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The routes start evaluateAndRespond fire-and-forget, and startSession reads the
// module-wide session manager that the next test's createConversationsApp overwrites.
// Track every run so afterEach can wait for it: a responder must never outlive its test.
const inFlightResponders = vi.hoisted(() => new Set<Promise<unknown>>())
vi.mock('../../services/conversation-responder', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/conversation-responder')>()
	return {
		...actual,
		evaluateAndRespond: (...args: Parameters<typeof actual.evaluateAndRespond>) => {
			const run = actual.evaluateAndRespond(...args)
			inFlightResponders.add(run)
			const done = () => inFlightResponders.delete(run)
			run.then(done, done)
			return run
		},
	}
})

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: {
			createSession: ReturnType<typeof vi.fn>
			findActiveConversationSession: ReturnType<typeof vi.fn>
			findConversationSessionAnyActive: ReturnType<typeof vi.fn>
			drainPendingConversationTurns: ReturnType<typeof vi.fn>
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
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })

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

// The routes start the responder fire-and-forget, so how long a session takes to be created depends
// on the runner. Poll for it rather than sleeping a fixed 50 ms and asserting.
async function waitForSessions(
	sessionManager: { createSession: ReturnType<typeof vi.fn> },
	count: number,
) {
	await vi.waitFor(
		() => expect(sessionManager.createSession.mock.calls.length).toBeGreaterThanOrEqual(count),
		{ timeout: 5_000 },
	)
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

	afterEach(async () => {
		await Promise.allSettled([...inFlightResponders])
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

		it('stores structured metadata on the initial message', async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app } = createConversationsApp(ownerId)

			const objectId = crypto.randomUUID()
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{
						title: 'With context',
						participant_actor_ids: [other.id],
						initial_message: 'what does this contain?',
						initial_message_metadata: {
							context_objects: [{ id: objectId, title: 'Signup context', type: 'knowledge' }],
						},
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
			const body = (await res.json()) as { id: string }

			const messagesRes = await app.request(
				jsonGet(`/api/conversations/${body.id}/messages`, { 'x-workspace-id': workspaceId }),
			)
			const messagesBody = (await messagesRes.json()) as {
				messages: Array<{ metadata: { context_objects?: Array<{ id: string; title?: string }> } }>
			}
			expect(messagesBody.messages[0]?.metadata?.context_objects).toEqual([
				{ id: objectId, title: 'Signup context', type: 'knowledge' },
			])
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
				conversations: Array<{
					id: string
					unread_count: number
					snippet: string | null
					snippet_actor_id: string | null
					snippet_actor_name: string | null
				}>
			}
			expect(list.conversations).toHaveLength(1)
			expect(list.conversations[0]?.id).toBe(conversation.id)
			expect(list.conversations[0]?.unread_count).toBe(1)
			expect(list.conversations[0]?.snippet).toBe('first message')
			// The preview carries its author across the actors join, so the list
			// row can say "Owner: first message" rather than attributing every
			// preview to whoever is reading it.
			expect(list.conversations[0]?.snippet_actor_id).toBe(ownerId)
			expect(list.conversations[0]?.snippet_actor_name).toBeTruthy()

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

		it("posting a message advances the sender's read cursor, humans only, never backwards", async () => {
			const other = await insertActor(db, { type: 'human' })
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, other.id)
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Thread', participant_actor_ids: [other.id, agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const headers = { 'x-workspace-id': workspaceId }
			const post = async (app: ReturnType<typeof createConversationsApp>['app'], content: string) =>
				(await (
					await app.request(
						jsonRequest(
							'POST',
							`/api/conversations/${conversation.id}/messages`,
							{ content },
							headers,
						),
					)
				).json()) as { id: number }
			const detail = async (app: ReturnType<typeof createConversationsApp>['app']) =>
				(await (
					await app.request(jsonGet(`/api/conversations/${conversation.id}`, headers))
				).json()) as { unread_count: number; last_read_message_id: number | null }

			const m1 = await post(ownerApp, 'question')
			const m2 = await post(ownerApp, 'follow-up')

			// A reply reads everything before it, without any PATCH /me from the client.
			const { app: otherApp } = createConversationsApp(other.id)
			expect((await detail(otherApp)).unread_count).toBe(2)
			const reply = await post(otherApp, 'answer')
			const afterReply = await detail(otherApp)
			expect(afterReply.last_read_message_id).toBe(reply.id)
			expect(afterReply.unread_count).toBe(0)

			// An older mark-read cannot pull it back.
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: m1.id },
					headers,
				),
			)
			expect((await detail(otherApp)).last_read_message_id).toBe(reply.id)

			// Messages that arrive after the reply are unread, and the cursor never skips ahead of them.
			const m3 = await post(ownerApp, 'later')
			expect(m3.id).toBeGreaterThan(m2.id)
			const later = await detail(otherApp)
			expect(later.unread_count).toBe(1)
			expect(later.last_read_message_id).toBe(reply.id)

			// An agent posting mid-turn does not move its own cursor.
			const { app: agentApp } = createConversationsApp(agent.id, 'agent')
			await post(agentApp, 'working on it')
			expect((await detail(agentApp)).last_read_message_id).toBeNull()
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

		it('mark_unread resets the read cursor to null, unclamped by the GREATEST guard', async () => {
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
			const readDetail = async () => {
				const res = await otherApp.request(
					jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
				)
				return (await res.json()) as {
					unread_count: number
					last_read_message_id: number | null
				}
			}

			// Both owner messages are unread to start with.
			expect((await readDetail()).unread_count).toBe(2)

			// Advance to the newest message, then reset.
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: msg2.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect((await readDetail()).last_read_message_id).toBe(msg2.id)

			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ mark_unread: true },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const afterReset = await readDetail()
			expect(afterReset.last_read_message_id).toBeNull()
			expect(afterReset.unread_count).toBe(2)

			// A reset is not a one-way door: a later advance still works.
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: msg1.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect((await readDetail()).last_read_message_id).toBe(msg1.id)

			// The GREATEST guard still applies to plain advances: an older id no-ops.
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: msg2.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ last_read_message_id: msg1.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect((await readDetail()).last_read_message_id).toBe(msg2.id)

			// And a second reset still reaches null after an advance.
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ mark_unread: true },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const afterSecondReset = await readDetail()
			expect(afterSecondReset.last_read_message_id).toBeNull()
			expect(afterSecondReset.unread_count).toBe(2)
		})

		it('rejects mark_unread combined with last_read_message_id', async () => {
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

			const { app: otherApp } = createConversationsApp(other.id)
			const res = await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ mark_unread: true, last_read_message_id: 5 },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(400)
		})

		it('unread_only=true excludes conversations the caller has fully read', async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app: ownerApp } = createConversationsApp(ownerId)

			const readThread = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Read thread', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const readConversation = (await readThread.json()) as { id: string }
			const unreadThread = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Unread thread', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const unreadConversation = (await unreadThread.json()) as { id: string }

			const { app: otherApp } = createConversationsApp(other.id)
			for (const conversationId of [readConversation.id, unreadConversation.id]) {
				await ownerApp.request(
					jsonRequest(
						'POST',
						`/api/conversations/${conversationId}/messages`,
						{ content: 'ping' },
						{ 'x-workspace-id': workspaceId },
					),
				)
			}
			const readMessages = await otherApp.request(
				jsonGet(`/api/conversations/${readConversation.id}/messages`, {
					'x-workspace-id': workspaceId,
				}),
			)
			const { messages: readMsgs } = (await readMessages.json()) as {
				messages: Array<{ id: number }>
			}
			await otherApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${readConversation.id}/me`,
					{ last_read_message_id: readMsgs[0]?.id },
					{ 'x-workspace-id': workspaceId },
				),
			)

			const filtered = await otherApp.request(
				jsonGet('/api/conversations?unread_only=true', { 'x-workspace-id': workspaceId }),
			)
			expect(filtered.status).toBe(200)
			const filteredBody = (await filtered.json()) as { conversations: Array<{ id: string }> }
			expect(filteredBody.conversations.map((c) => c.id)).toEqual([unreadConversation.id])

			const unfiltered = await otherApp.request(
				jsonGet('/api/conversations', { 'x-workspace-id': workspaceId }),
			)
			const unfilteredBody = (await unfiltered.json()) as { conversations: Array<{ id: string }> }
			expect(unfilteredBody.conversations).toHaveLength(2)
		})

		it('logs an events row when updating pin/archive/read state via PATCH /:id/me', async () => {
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Audited', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const res = await ownerApp.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/me`,
					{ pinned: true },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)

			const rows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'conversation_participant_state_updated'),
					),
				)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.actorId).toBe(ownerId)
		})
	})

	describe('list for an agent finding chats to follow up', () => {
		type ListBody = {
			conversations: Array<{ id: string; snippet_is_caller: boolean; lastMessageAt: string }>
			has_more: boolean
		}

		async function createChat(
			creatorId: string,
			creatorType: 'human' | 'agent',
			participantIds: string[],
			message: string,
		) {
			const { app } = createConversationsApp(creatorId, creatorType)
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: message, participant_actor_ids: participantIds, initial_message: message },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
			return ((await res.json()) as { id: string }).id
		}

		async function listAs(agentId: string, query: string) {
			const { app } = createConversationsApp(agentId, 'agent')
			const res = await app.request(
				jsonGet(`/api/conversations?${query}`, { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(200)
			return (await res.json()) as ListBody
		}

		it('filters by human participants and recent activity, newest first, and flags the callers own message', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			const otherAgent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			await addMember(workspaceId, otherAgent.id)

			const withHumanOld = await createChat(ownerId, 'human', [agent.id], 'older person chat')
			const agentsOnly = await createChat(agent.id, 'agent', [otherAgent.id], 'agents only')
			const withHumanNew = await createChat(ownerId, 'human', [agent.id], 'newer person chat')
			// Make the order explicit rather than relying on insert timing.
			const at = (iso: string) => new Date(iso)
			await db
				.update(conversations)
				.set({ lastMessageAt: at('2026-10-20T10:00:00Z') })
				.where(eq(conversations.id, withHumanOld))
			await db
				.update(conversations)
				.set({ lastMessageAt: at('2026-10-22T10:00:00Z') })
				.where(eq(conversations.id, agentsOnly))
			await db
				.update(conversations)
				.set({ lastMessageAt: at('2026-10-23T10:00:00Z') })
				.where(eq(conversations.id, withHumanNew))

			const all = await listAs(agent.id, 'sort=activity')
			expect(all.conversations.map((c) => c.id)).toEqual([withHumanNew, agentsOnly, withHumanOld])

			const withPeople = await listAs(agent.id, 'sort=activity&has_human=true')
			expect(withPeople.conversations.map((c) => c.id)).toEqual([withHumanNew, withHumanOld])

			const recent = await listAs(agent.id, 'sort=activity&updated_after=2026-10-21T00:00:00Z')
			expect(recent.conversations.map((c) => c.id)).toEqual([withHumanNew, agentsOnly])

			const recentWithPeople = await listAs(
				agent.id,
				'sort=activity&has_human=true&updated_after=2026-10-21T00:00:00Z',
			)
			expect(recentWithPeople.conversations.map((c) => c.id)).toEqual([withHumanNew])

			// The agent wrote the agents-only chat's last message; a person wrote the others.
			const byId = new Map(all.conversations.map((c) => [c.id, c.snippet_is_caller]))
			expect(byId.get(agentsOnly)).toBe(true)
			expect(byId.get(withHumanNew)).toBe(false)
		})

		it('does not list chats the caller is not in', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			const outsider = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			await addMember(workspaceId, outsider.id)
			await createChat(ownerId, 'human', [agent.id], 'not for the outsider')

			const list = await listAs(outsider.id, 'sort=activity&has_human=true')
			expect(list.conversations).toEqual([])
		})

		it('rejects an updated_after that is not a time', async () => {
			const { app } = createConversationsApp(ownerId)
			const res = await app.request(
				jsonGet('/api/conversations?updated_after=yesterday', { 'x-workspace-id': workspaceId }),
			)
			expect(res.status).toBe(400)
		})
	})

	describe('participants', () => {
		it('auto-joins an @mentioned agent who is not yet a participant, so they become a responder candidate', async () => {
			// Regression: @mentioning an agent via the composer used to be a
			// no-op unless they were already a conversation participant, because
			// evaluateAndRespond's candidate query only reads active
			// conversationParticipants rows — the mention itself was never
			// promoted into one.
			const other = await insertActor(db, { type: 'human' })
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, other.id)
			await addMember(workspaceId, agent.id)
			const { app: ownerApp, sessionManager } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'No agent yet', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const messageRes = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: `hey <@${agent.id}>`, metadata: { mentions: [agent.id] } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(messageRes.status).toBe(201)

			const detail = await ownerApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody = (await detail.json()) as { participants: Array<{ actorId: string }> }
			expect(detailBody.participants.map((p) => p.actorId).sort()).toEqual(
				[ownerId, other.id, agent.id].sort(),
			)

			// evaluateAndRespond is fire-and-forget from the route (not awaited)
			// — give the microtask queue a turn before asserting.
			await waitForSessions(sessionManager, 1)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession.mock.calls[0]?.[1]).toMatchObject({ actorId: agent.id })
		})

		it('reports mentioned ids that are neither participants nor workspace members, and still posts', async () => {
			// A mistyped or foreign UUID used to be dropped without a word, so the
			// author never learned nobody was pulled in. It must come back in
			// `unresolved_mentions`, while a real workspace member in the same
			// message still joins and is not reported.
			const agent = await insertActor(db, { type: 'agent' })
			const outsider = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const typo = '00000000-0000-4000-8000-000000000000'
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Bad mentions', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const messageRes = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'hello', metadata: { mentions: [agent.id, typo, outsider.id, typo] } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(messageRes.status).toBe(201)
			const body = (await messageRes.json()) as { id: number; unresolved_mentions?: string[] }
			expect(body.id).toBeGreaterThan(0)
			expect([...(body.unresolved_mentions ?? [])].sort()).toEqual([outsider.id, typo].sort())

			const detail = await ownerApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody = (await detail.json()) as { participants: Array<{ actorId: string }> }
			expect(detailBody.participants.map((p) => p.actorId)).toContain(agent.id)
			expect(detailBody.participants.map((p) => p.actorId)).not.toContain(outsider.id)
		})

		it('omits unresolved_mentions when every mention resolves', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Good mentions', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const messageRes = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'hello', metadata: { mentions: [agent.id] } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(messageRes.status).toBe(201)
			expect(await messageRes.json()).not.toHaveProperty('unresolved_mentions')
		})

		it('auto-joins both actors in a two-actor mention and lets both responders see wasMentioned=true', async () => {
			// Two-actor mention case: neither is a participant, both must be
			// promoted, both must be handed to `evaluateAndRespond` with the
			// wasMentioned=true short-circuit (proxied here by the responder
			// picking up both agents as candidates and calling createSession
			// for each).
			const agentA = await insertActor(db, { type: 'agent' })
			const agentB = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agentA.id)
			await addMember(workspaceId, agentB.id)
			const { app: ownerApp, sessionManager } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Two mentions', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const messageRes = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{
						content: `hey <@${agentA.id}> <@${agentB.id}>`,
						metadata: { mentions: [agentA.id, agentB.id] },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(messageRes.status).toBe(201)

			const detail = await ownerApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody = (await detail.json()) as { participants: Array<{ actorId: string }> }
			expect(detailBody.participants.map((p) => p.actorId).sort()).toEqual(
				[ownerId, agentA.id, agentB.id].sort(),
			)

			// evaluateAndRespond is fire-and-forget from the route — give it a turn.
			await waitForSessions(sessionManager, 2)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
			const sessionActorIds = sessionManager.createSession.mock.calls
				.map((call) => (call[1] as { actorId: string }).actorId)
				.sort()
			expect(sessionActorIds).toEqual([agentA.id, agentB.id].sort())

			// Re-mentioning the same actor a second time is idempotent — no new
			// participant row, no duplicate `conversation_participant_added` event.
			const priorEvents = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'conversation_participant_added'),
					),
				)
			const remention = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{
						content: `hey again <@${agentA.id}>`,
						metadata: { mentions: [agentA.id] },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(remention.status).toBe(201)
			const laterEvents = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'conversation_participant_added'),
					),
				)
			expect(laterEvents).toHaveLength(priorEvents.length)
		})

		it('ignores a mention of an actor who is not a workspace member, without failing the message post', async () => {
			const outsider = await insertActor(db, { type: 'agent' })
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Solo', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const messageRes = await ownerApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: `hey <@${outsider.id}>`, metadata: { mentions: [outsider.id] } },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(messageRes.status).toBe(201)

			const detail = await ownerApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody = (await detail.json()) as { participants: Array<{ actorId: string }> }
			expect(detailBody.participants.map((p) => p.actorId)).toEqual([ownerId])
		})

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

		it('rejects a non-creator participant trying to remove another participant', async () => {
			// Regression: any active participant used to be able to evict any
			// other participant (including the creator) — only self-removal or
			// removal by the creator should be permitted.
			const other = await insertActor(db, { type: 'human' })
			const bystander = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			await addMember(workspaceId, bystander.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Guarded', participant_actor_ids: [other.id, bystander.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const { app: bystanderApp } = createConversationsApp(bystander.id)
			const res = await bystanderApp.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${other.id}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(403)

			const detail = await ownerApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			const detailBody = (await detail.json()) as { participants: Array<{ actorId: string }> }
			expect(detailBody.participants.map((p) => p.actorId).sort()).toEqual(
				[ownerId, other.id, bystander.id].sort(),
			)
		})

		it('allows a participant to remove themself (leave)', async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Leaving', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const { app: otherApp } = createConversationsApp(other.id)
			const res = await otherApp.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${other.id}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(res.status).toBe(204)

			const detail = await otherApp.request(
				jsonGet(`/api/conversations/${conversation.id}`, { 'x-workspace-id': workspaceId }),
			)
			expect(detail.status).toBe(404)
		})

		it('does not write an audit event when removing an already-left participant', async () => {
			// Regression: the removal handler used to insert a
			// conversation_participant_removed event unconditionally, even when
			// the UPDATE affected zero rows (actor already removed / never a
			// participant), so the audit log recorded removals that never happened.
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Double removal', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const first = await ownerApp.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${other.id}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(first.status).toBe(204)

			const countAfterFirst = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'conversation_participant_removed'),
					),
				)
			expect(countAfterFirst.length).toBe(1)

			const second = await ownerApp.request(
				jsonDelete(`/api/conversations/${conversation.id}/participants/${other.id}`, {
					'x-workspace-id': workspaceId,
				}),
			)
			expect(second.status).toBe(204)

			const countAfterSecond = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'conversation_participant_removed'),
					),
				)
			expect(countAfterSecond.length).toBe(1)
		})
	})

	describe('server-owned message metadata', () => {
		it('strips a client-claimed final_output marker', async () => {
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Metadata', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{
						content: 'not really a final output',
						metadata: {
							source: 'final_output',
							final_output: { dedupe_key: 'forged' },
							mentions: [],
						},
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)

			// The frontend reconciles its optimistic bubble against `source`, so a
			// forged marker would strand that bubble on screen permanently.
			const body = (await res.json()) as { metadata: Record<string, unknown> | null }
			expect(body.metadata?.source).toBeUndefined()
			expect(body.metadata?.final_output).toBeUndefined()
			expect(body.metadata?.mentions).toEqual([])
		})

		it('strips a client-claimed delivery marker, so a person cannot forge one', async () => {
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Delivery', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{
						content: 'not really an intro',
						metadata: { delivery: { kind: 'agent_intro', version: 1 }, mentions: [] },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)

			// A forged marker would poison the intro cap and the dedupe checks, which
			// count messages by metadata.delivery.kind.
			const [stored] = await db
				.select()
				.from(messages)
				.where(eq(messages.conversationId, conversation.id))
			expect(stored?.metadata).toEqual({ mentions: [] })
		})

		it('strips a client-claimed helper_return marker, so a person cannot hide a message', async () => {
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Helper return', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{
						content: 'not really a helper result',
						metadata: { helper_return: '11111111-1111-4111-8111-111111111111', mentions: [] },
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)

			// The web thread hides any message carrying this key, so a forged one would
			// let a client post a message the other participants never see.
			const [stored] = await db
				.select()
				.from(messages)
				.where(eq(messages.conversationId, conversation.id))
			expect(stored?.metadata).toEqual({ mentions: [] })
		})

		it('still posts the message, bumps lastMessageAt and logs the event', async () => {
			// The insert path moved into a shared helper so the turn finalizer can
			// reuse it — this pins the route's behaviour as unchanged.
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Helper', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'hello there' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)

			const [row] = await db
				.select()
				.from(conversations)
				.where(eq(conversations.id, conversation.id))
			expect(row?.lastMessageAt).not.toBeNull()

			const eventRows = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, conversation.id), eq(events.action, 'message_posted')))
			expect(eventRows).toHaveLength(1)
		})
	})

	describe('raw-secret backstop', () => {
		// Obviously fake, assembled at runtime so no token-shaped literal sits in the repo.
		const fakeToken = `ghp_${'a'.repeat(36)}`

		async function startConversation(app: ReturnType<typeof createConversationsApp>['app']) {
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Backstop', participant_actor_ids: [] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			return (await created.json()) as { id: string }
		}

		const post = (
			app: ReturnType<typeof createConversationsApp>['app'],
			conversationId: string,
			content: string,
		) =>
			app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversationId}/messages`,
					{ content },
					{ 'x-workspace-id': workspaceId },
				),
			)

		it('returns 400 RAW_SECRET_DETECTED, stores no message and records a bypass event without the value', async () => {
			const { app, sessionManager } = createConversationsApp(ownerId)
			const conversation = await startConversation(app)

			const res = await post(app, conversation.id, `use this key ${fakeToken} please`)
			expect(res.status).toBe(400)
			const body = (await res.json()) as { error: { code: string; message: string } }
			expect(body.error.code).toBe('RAW_SECRET_DETECTED')
			expect(JSON.stringify(body)).not.toContain(fakeToken)

			const stored = await db
				.select()
				.from(messages)
				.where(eq(messages.conversationId, conversation.id))
			expect(stored).toHaveLength(0)
			// Nothing was handed to an agent either.
			expect(sessionManager.writeInput).not.toHaveBeenCalled()
			expect(sessionManager.createSession).not.toHaveBeenCalled()

			const eventRows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'credential_scanner_bypass_attempt'),
					),
				)
			expect(eventRows).toHaveLength(1)
			expect(eventRows[0]?.data).toMatchObject({ pattern_id: 'github', caller_type: 'human' })
			expect(JSON.stringify(eventRows)).not.toContain(fakeToken)
		})

		it('refuses an edit that adds a secret, keeps the stored text and records a bypass event', async () => {
			const { app, sessionManager } = createConversationsApp(ownerId)
			const conversation = await startConversation(app)
			const sent = await post(app, conversation.id, 'a clean message')
			const { id: messageId } = (await sent.json()) as { id: number }
			sessionManager.writeInput.mockClear()

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/messages/${messageId}`,
					{ content: `now with ${fakeToken}` },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(400)
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'RAW_SECRET_DETECTED',
			)
			const [stored] = await db.select().from(messages).where(eq(messages.id, messageId))
			expect(stored?.content).toBe('a clean message')
			expect(sessionManager.writeInput).not.toHaveBeenCalled()
			const eventRows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, conversation.id),
						eq(events.action, 'credential_scanner_bypass_attempt'),
					),
				)
			expect(eventRows).toHaveLength(1)
			expect(JSON.stringify(eventRows)).not.toContain(fakeToken)
		})

		it('refuses a secret in the initial message and creates no conversation', async () => {
			const { app } = createConversationsApp(ownerId)
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Seeded', participant_actor_ids: [], initial_message: fakeToken },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(400)
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				'RAW_SECRET_DETECTED',
			)
			const eventRows = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityId, workspaceId),
						eq(events.action, 'credential_scanner_bypass_attempt'),
					),
				)
			expect(eventRows).toHaveLength(1)
		})

		it('applies to agent callers too', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const human = createConversationsApp(ownerId)
			const conversation = await startConversation(human.app)
			await db.execute(
				sql`INSERT INTO conversation_participants (conversation_id, actor_id) VALUES (${conversation.id}, ${agent.id})`,
			)
			const { app } = createConversationsApp(agent.id, 'agent')
			const res = await post(app, conversation.id, fakeToken)
			expect(res.status).toBe(400)
		})

		it('lets the redaction marker through', async () => {
			const { app } = createConversationsApp(ownerId)
			const conversation = await startConversation(app)
			const res = await post(app, conversation.id, 'here it is ghp_[REDACTED · vaulted as NAME]')
			expect(res.status).toBe(201)
		})

		it('lets the manual redaction marker through for names built from every provider prefix', async () => {
			const { app } = createConversationsApp(ownerId)
			const conversation = await startConversation(app)
			const prefixes = [
				'cfut_',
				'cfat_',
				'cfk_',
				'ghp_',
				'github_pat_',
				'sk_live_',
				'sk_test_',
				'xoxb-',
				'xoxp-',
				'sk-',
				'sk-proj-',
				'sk-svcacct-',
			]
			for (const prefix of prefixes) {
				// The bare prefix, and the longest name the name rule still lets through.
				const names = [prefix]
				for (let n = 1; n <= CREDENTIAL_NAME_MAX_LENGTH - prefix.length; n++) {
					const name = `${prefix}${'a'.repeat(n)}`
					if (checkCredentialName(name) === null) names[1] = name
				}
				for (const name of names) {
					expect(checkCredentialName(name)).toBeNull()
					const res = await post(app, conversation.id, manualRedactionMarker(name))
					expect(res.status).toBe(201)
				}
			}
		})

		it('lets ordinary messages and amber-only blobs through', async () => {
			const { app } = createConversationsApp(ownerId)
			const conversation = await startConversation(app)
			expect((await post(app, conversation.id, 'hello there')).status).toBe(201)
			expect(
				(await post(app, conversation.id, `commit ${'0123456789abcdef'.repeat(3)}`)).status,
			).toBe(201)
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

			// Stamp both the indexed sessions.conversationId column (what the route's
			// ownership check now queries) and config.conversation (what launched
			// sessions carry) so the ownership check in the route passes.
			await db
				.update(sessions)
				.set({
					config: { conversation: { conversation_id: conversation.id, message_id: 1 } },
					conversationId: conversation.id,
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

		it('drops session_id when the indexed conversationId column does not match, even if config.conversation still claims this conversation', async () => {
			// Regression: the ownership check used to scan config->'conversation'
			// ->>'conversation_id' (unindexed JSONB) instead of the indexed
			// conversationId column those two are supposed to stay in sync — this
			// proves the indexed column is now the actual source of truth.
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

			// config.conversation claims this conversation, but conversationId is
			// deliberately left pointing elsewhere (simulates drift between the two
			// representations).
			await db
				.update(sessions)
				.set({
					config: { conversation: { conversation_id: conversation.id, message_id: 1 } },
					conversationId: null,
				})
				.where(eq(sessions.id, session.id))

			const { app: agentApp } = createConversationsApp(agent.id, 'agent')
			const res = await agentApp.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{ content: 'agent reply', session_id: session.id },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
			const body = (await res.json()) as { sessionId: string | null }
			expect(body.sessionId).toBeNull()
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
			await waitForSessions(sessionManager, 1)
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
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValue({ id: 'existing-session-id', status: 'running', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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
			// The triggering message id is tagged onto the turn (4th arg) so the
			// chat UI can anchor this turn's activity dropdown to this message.
			expect(sessionManager.writeInput.mock.calls[0]?.[3]).toBe(triggering.id)
			// The delivered turn carries the sender's stable actor id alongside
			// their display name, so the receiving agent can attribute the message
			// even when names collide, change, or belong to another agent.
			const turn = sessionManager.writeInput.mock.calls[0]?.[1] as {
				message: { content: string }
			}
			expect(turn.message.content).toContain(ownerId)
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
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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

		it('includes attached files in the spawned session prompt with instructions to fetch them', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Attachment prompt test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({
					conversationId: conversation.id,
					actorId: ownerId,
					content: 'can you please give a summary of this file?',
					metadata: {
						mentions: [agent.id],
						attachments: [
							{
								file_id: '11111111-1111-1111-1111-111111111111',
								name: 'report.pdf',
								mime_type: 'application/pdf',
							},
						],
					},
				})
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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
			expect(params.actionPrompt).toContain('report.pdf')
			expect(params.actionPrompt).toContain('11111111-1111-1111-1111-111111111111')
			expect(params.actionPrompt).toContain('get_file')
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
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValue({ id: 'dead-session-id', status: 'running', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockRejectedValue(new Error('container gone')),
				markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
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
				// violation simulated above. The winner lookup then finds a running
				// session to join.
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce({ id: 'winner-session-id', status: 'running', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				createSession: vi.fn().mockRejectedValue(raceViolation),
				writeInput: vi.fn().mockRejectedValue(new Error('container gone')),
				markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.writeInput).toHaveBeenCalledWith(
				'winner-session-id',
				expect.anything(),
				undefined,
				triggering.id,
			)
			expect(sessionManager.markSessionFailedAfterContainerLoss).toHaveBeenCalledWith(
				'winner-session-id',
				workspaceId,
			)
		})

		it('buffers the turn instead of dropping it when the agent session is still booting', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Boot buffer test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'quick follow-up' })
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: 'should-not-be-used' }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValue({ id: 'booting-session-id', status: 'starting', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.writeInput).not.toHaveBeenCalled()
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			const [buffered] = await db
				.select()
				.from(conversationPendingTurns)
				.where(eq(conversationPendingTurns.messageId, triggering.id))
			expect(buffered).toBeTruthy()
			expect(buffered?.actorId).toBe(agent.id)
			expect(buffered?.conversationId).toBe(conversation.id)
			expect((buffered?.payload as { message: { content: string } }).message.content).toContain(
				'quick follow-up',
			)
		})

		it('replaces a buffered turn payload when the message is edited while the session boots', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Edit re-buffer test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'deploy to prod' })
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn(),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValue({ id: 'booting-session-id', status: 'starting', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			// The user corrects the message while the session is still booting —
			// the buffered turn must carry the edited content, not the original.
			await db
				.update(messages)
				.set({ content: 'deploy to staging' })
				.where(eq(messages.id, triggering.id))
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
				options: { isEdit: true },
			})

			const rows = await db
				.select()
				.from(conversationPendingTurns)
				.where(eq(conversationPendingTurns.messageId, triggering.id))
			expect(rows).toHaveLength(1)
			const content = (rows[0]?.payload as { message: { content: string } }).message.content
			expect(content).toContain('deploy to staging')
			expect(content).not.toContain('deploy to prod')
			expect(content).toContain('edited an earlier message')
		})

		it('drains the freshly buffered turn itself when the session reaches running mid-buffer', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Boot race drain test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'racing message' })
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn(),
				// Booting on the primary lookup, but running by the post-buffer
				// re-check — the responder must drain the row it just wrote, since
				// the post-boot drain has already come and gone.
				findActiveConversationSession: vi
					.fn()
					.mockResolvedValue({ id: 'now-running-id', status: 'running', workspaceId }),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValue({ id: 'now-running-id', status: 'starting', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.drainPendingConversationTurns).toHaveBeenCalledWith('now-running-id')
		})

		it('buffers the turn when the race-winner session is still booting', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Race buffer test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [triggering] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'race me' })
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const raceViolation = Object.assign(new Error('duplicate key value'), {
				code: '23505',
				constraint_name: 'sessions_conversation_actor_active_uniq',
			})
			const sessionManager = {
				createSession: vi.fn().mockRejectedValue(raceViolation),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi
					.fn()
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce({ id: 'winner-booting-id', status: 'pending', workspaceId }),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.writeInput).not.toHaveBeenCalled()
			const [buffered] = await db
				.select()
				.from(conversationPendingTurns)
				.where(eq(conversationPendingTurns.messageId, triggering.id))
			expect(buffered).toBeTruthy()
			expect(buffered?.actorId).toBe(agent.id)
		})

		it('clears seed-covered pending turns after spawning a fresh session', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app: ownerApp } = createConversationsApp(ownerId)
			const created = await ownerApp.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Seed cleanup test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			// A stale buffered turn from a session that died before draining.
			const [stale] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'stale turn' })
				.returning()
			if (!stale) throw new Error('failed to insert stale message')
			await db.insert(conversationPendingTurns).values({
				conversationId: conversation.id,
				actorId: agent.id,
				messageId: stale.id,
				payload: { type: 'user', message: { role: 'user', content: 'stale turn' } },
			})
			const [triggering] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'fresh spawn' })
				.returning()
			if (!triggering) throw new Error('failed to insert triggering message')

			const sessionManager = {
				createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
				findActiveConversationSession: vi.fn().mockResolvedValue(null),
				findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
				drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
				writeInput: vi.fn().mockResolvedValue(undefined),
			}
			configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId: conversation.id,
				messageId: triggering.id,
			})

			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			// The seed prompt inlines history through the triggering message, so
			// the stale row (messageId < triggering) must be gone.
			const remaining = await db
				.select()
				.from(conversationPendingTurns)
				.where(eq(conversationPendingTurns.conversationId, conversation.id))
			expect(remaining).toHaveLength(0)
		})
	})

	describe('message editing', () => {
		it('lets the author edit their message and stamps editedAt', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{
						title: 'Edit test',
						participant_actor_ids: [agent.id],
						initial_message: 'original wording',
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [msg] = await db
				.select()
				.from(messages)
				.where(eq(messages.conversationId, conversation.id))

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/messages/${msg?.id}`,
					{ content: 'corrected wording' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { content: string; editedAt: string | null }
			expect(body.content).toBe('corrected wording')
			expect(body.editedAt).toBeTruthy()

			const [updated] = await db
				.select()
				.from(messages)
				.where(eq(messages.id, msg?.id ?? -1))
			expect(updated?.content).toBe('corrected wording')
			expect(updated?.editedAt).toBeTruthy()

			const auditRows = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, conversation.id), eq(events.action, 'message_updated')))
			expect(auditRows).toHaveLength(1)
		})

		it('re-runs the responder when the newest message is edited', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app, sessionManager } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Edit responder test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [msg] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'typo here' })
				.returning()

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/messages/${msg?.id}`,
					{ content: 'typo fixed' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			// Fire-and-forget responder — let the microtask queue drain.
			await waitForSessions(sessionManager, 1)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			const [, params] = sessionManager.createSession.mock.calls[0] as [
				string,
				{ actionPrompt: string },
			]
			expect(params.actionPrompt).toContain('typo fixed')
			expect(params.actionPrompt).toContain('edited an earlier message')
		})

		it('does not re-run the responder when an older message is edited', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app, sessionManager } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Old edit test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [older] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'older message' })
				.returning()
			await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'newest message' })

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/messages/${older?.id}`,
					{ content: 'older message, fixed' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it("rejects editing someone else's message", async () => {
			const other = await insertActor(db, { type: 'human' })
			await addMember(workspaceId, other.id)
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Foreign edit test', participant_actor_ids: [other.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [msg] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: other.id, content: 'not yours' })
				.returning()

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/conversations/${conversation.id}/messages/${msg?.id}`,
					{ content: 'hijacked' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(403)
		})
	})

	describe('message retry', () => {
		it('re-runs the responder for the message, forcing a reply', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app, sessionManager } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Retry test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [msg] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'anyone there?' })
				.returning()

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages/${msg?.id}/retry`,
					undefined,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(202)
			await waitForSessions(sessionManager, 1)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			const [, params] = sessionManager.createSession.mock.calls[0] as [
				string,
				{ actionPrompt: string; actorId: string },
			]
			expect(params.actorId).toBe(agent.id)
			expect(params.actionPrompt).toContain('anyone there?')
		})

		it('scopes the retry to one agent when agent_id is given', async () => {
			const agentA = await insertActor(db, { type: 'agent' })
			const agentB = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agentA.id)
			await addMember(workspaceId, agentB.id)
			const { app, sessionManager } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Scoped retry test', participant_actor_ids: [agentA.id, agentB.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }
			const [msg] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: ownerId, content: 'redo just A' })
				.returning()

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages/${msg?.id}/retry?agent_id=${agentA.id}`,
					undefined,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(202)
			await waitForSessions(sessionManager, 1)
			// Give a wrongly started second reply a moment to show up before asserting there is none.
			await new Promise((resolve) => setTimeout(resolve, 50))
			// Only the targeted agent re-runs — B must not post a duplicate reply.
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			const [, params] = sessionManager.createSession.mock.calls[0] as [string, { actorId: string }]
			expect(params.actorId).toBe(agentA.id)
		})

		it('returns 404 for a message outside the conversation', async () => {
			const agent = await insertActor(db, { type: 'agent' })
			await addMember(workspaceId, agent.id)
			const { app } = createConversationsApp(ownerId)
			const created = await app.request(
				jsonRequest(
					'POST',
					'/api/conversations',
					{ title: 'Retry 404 test', participant_actor_ids: [agent.id] },
					{ 'x-workspace-id': workspaceId },
				),
			)
			const conversation = (await created.json()) as { id: string }

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/conversations/${conversation.id}/messages/999999999/retry`,
					undefined,
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(404)
		})
	})
})
