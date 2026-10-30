import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq, isNotNull } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { directPairKey } from '../../services/direct-chat'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: conversationsRoutes } = await import('../../routes/conversations')

/**
 * POST /sessions/:id/ask — the route the in-container AskUserQuestion hook
 * posts to (docker/agent-base/hooks/ask-user-question.sh).
 *
 * Against real Postgres because the behaviour under test is a write: the
 * question has to land as a real `messages` row, with the backend-owned
 * `metadata.question` marker the chat UI keys its option chips off. The
 * availability gate is the other half — an autonomous session must be refused,
 * and that decision reads `sessions.interactive` / `sessions.conversationId`,
 * which a mocked db can only assert against itself.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

function createSessionsApp(actorId: string) {
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

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'agent')
		c.set('sessionManager', {
			createSession: vi.fn(),
			writeInput: vi.fn(),
		} as unknown as Env['Variables']['sessionManager'])
		await next()
	})

	app.route('/api/sessions', sessionsRoutes)
	return app
}

function createConversationsApp(actorId: string) {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', {} as unknown as Env['Variables']['sessionManager'])
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

const QUESTIONS = [
	{
		question: 'How should I reach Spotify?',
		header: 'Spotify access',
		multi_select: false,
		options: [
			{ label: 'API token', description: 'You create a developer app' },
			{ label: 'No login', description: 'Curate a shareable link instead' },
		],
	},
]

function ask(sessionId: string, workspaceId: string, body: unknown = { questions: QUESTIONS }) {
	return jsonRequest('POST', `/api/sessions/${sessionId}/ask`, body, {
		'X-Workspace-Id': workspaceId,
	})
}

describe('POST /sessions/:id/ask', () => {
	let workspaceId: string
	let agentId: string
	let humanId: string
	let conversationId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id

		const agent = await insertActor(db, { type: 'agent' })
		if (!agent) throw new Error('failed to seed agent')
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })

		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Test chat', createdBy: humanId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		conversationId = conversation.id
	})

	async function messagesFor(conversation: string) {
		return db.select().from(messages).where(eq(messages.conversationId, conversation))
	}

	// The stored direct messages of the workspace: the conversations that carry a pair key.
	async function directChatRows(forWorkspace = workspaceId) {
		const rows = await db
			.select({ conversationId: conversations.id, key: conversations.directPairKey })
			.from(conversations)
			.where(
				and(eq(conversations.workspaceId, forWorkspace), isNotNull(conversations.directPairKey)),
			)
		return rows
	}

	it('posts the question into the conversation as the agent', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		const res = await app.request(ask(session.id, workspaceId))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { message_id: number; posted: boolean }
		expect(body.posted).toBe(true)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		const metadata = rows[0]?.metadata as {
			question?: { session_id: string; questions: unknown[] }
		}
		expect(metadata.question?.session_id).toBe(session.id)
		expect(metadata.question?.questions).toHaveLength(1)
		// The markdown fallback is what every non-chip reader shows, so it has to
		// carry the question and the options, not just a placeholder.
		expect(rows[0]?.content).toContain('How should I reach Spotify?')
		expect(rows[0]?.content).toContain('API token')
	})

	describe('with no chat and no helper parent', () => {
		type QuestionMeta = {
			question?: { reply_to_session?: boolean; routed_to?: string; session_id: string }
		}

		it("puts an autonomous session's question in the asking agent's direct message", async () => {
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			if (!session) throw new Error('failed to seed session')
			const app = createSessionsApp(agentId)

			const res = await app.request(ask(session.id, workspaceId))
			expect(res.status).toBe(200)
			expect(((await res.json()) as { delivered_to: string }).delivered_to).toBe('master')

			const [master] = await directChatRows()
			if (!master) throw new Error('no direct message was created')
			expect(master.key).toBe(directPairKey(humanId, agentId))
			const [chat] = await db
				.select()
				.from(conversations)
				.where(eq(conversations.id, master.conversationId))
			expect(chat).toMatchObject({ createdBy: humanId, titleAutoState: 'none' })
			const rows = await messagesFor(master.conversationId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.actorId).toBe(agentId)
			expect(rows[0]?.content).toContain('How should I reach Spotify?')
			const metadata = rows[0]?.metadata as QuestionMeta
			expect(metadata.question?.reply_to_session).toBe(true)
			expect(metadata.question?.routed_to).toBe('master')
			expect(await messagesFor(conversationId)).toHaveLength(0)
		})

		it('does the same for an interactive session started without a chat', async () => {
			// Interactive alone is not a chat surface: a session started from the sessions UI has
			// a live stdin but no conversation, so its question goes to the direct message too.
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId: null,
				status: 'running',
			})
			if (!session) throw new Error('failed to seed session')
			const app = createSessionsApp(agentId)

			const res = await app.request(ask(session.id, workspaceId))
			expect(res.status).toBe(200)
			const [master] = await directChatRows()
			expect(await messagesFor(master?.conversationId as string)).toHaveLength(1)
			expect(await messagesFor(conversationId)).toHaveLength(0)
		})

		it('reuses the same direct message for every later question', async () => {
			const first = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			const second = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			if (!first || !second) throw new Error('failed to seed sessions')
			const app = createSessionsApp(agentId)

			expect((await app.request(ask(first.id, workspaceId))).status).toBe(200)
			expect((await app.request(ask(second.id, workspaceId))).status).toBe(200)

			const chats = await directChatRows()
			expect(chats).toHaveLength(1)
			expect(await messagesFor(chats[0]?.conversationId as string)).toHaveLength(2)
		})

		it('never uses a topical chat that holds only the same two people', async () => {
			await db.insert(conversationParticipants).values([
				{ conversationId, actorId: humanId },
				{ conversationId, actorId: agentId },
			])
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			if (!session) throw new Error('failed to seed session')
			const app = createSessionsApp(agentId)

			expect((await app.request(ask(session.id, workspaceId))).status).toBe(200)

			const [master] = await directChatRows()
			expect(master?.conversationId).not.toBe(conversationId)
			expect(await messagesFor(conversationId)).toHaveLength(0)
		})

		it('gives the Chief of Staff and a second agent a chat each, not a shared one', async () => {
			const cos = await insertActor(db, { type: 'agent', name: 'Chief of Staff' })
			if (!cos) throw new Error('failed to seed Chief of Staff')
			await db.insert(workspaceMembers).values({ workspaceId, actorId: cos.id, role: 'member' })
			const fromAgent = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			const fromCos = await insertSession(db, workspaceId, cos.id, humanId, {
				interactive: false,
				status: 'running',
			})
			if (!fromAgent || !fromCos) throw new Error('failed to seed sessions')

			expect(
				(await createSessionsApp(agentId).request(ask(fromAgent.id, workspaceId))).status,
			).toBe(200)
			expect((await createSessionsApp(cos.id).request(ask(fromCos.id, workspaceId))).status).toBe(
				200,
			)

			const chats = await directChatRows()
			expect(chats.map((c) => c.key).sort()).toEqual(
				[directPairKey(humanId, agentId), directPairKey(humanId, cos.id)].sort(),
			)
			expect(new Set(chats.map((c) => c.conversationId)).size).toBe(2)
			for (const chat of chats) expect(await messagesFor(chat.conversationId)).toHaveLength(1)
		})

		it('makes one direct message when several first questions arrive at once', async () => {
			const sessionsToAsk = await Promise.all(
				Array.from({ length: 4 }, () =>
					insertSession(db, workspaceId, agentId, humanId, {
						interactive: false,
						status: 'running',
					}),
				),
			)
			const app = createSessionsApp(agentId)

			const responses = await Promise.all(
				sessionsToAsk.map((s) => app.request(ask(s?.id as string, workspaceId))),
			)

			expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200])
			const chats = await directChatRows()
			expect(chats).toHaveLength(1)
			expect(await messagesFor(chats[0]?.conversationId as string)).toHaveLength(4)
		})

		it('asks in a fresh direct message once a third person has joined the first', async () => {
			const first = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			const second = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: false,
				status: 'running',
			})
			if (!first || !second) throw new Error('failed to seed sessions')
			expect((await createSessionsApp(agentId).request(ask(first.id, workspaceId))).status).toBe(
				200,
			)
			const [dm] = await directChatRows()
			if (!dm) throw new Error('no direct message was created')

			// Adding a third person through the route turns the direct message into a group chat.
			const third = await insertActor(db, { type: 'human' })
			await db.insert(workspaceMembers).values({ workspaceId, actorId: third.id, role: 'member' })
			const added = await createConversationsApp(humanId).request(
				jsonRequest(
					'POST',
					`/api/conversations/${dm.conversationId}/participants`,
					{ actor_ids: [third.id] },
					{ 'X-Workspace-Id': workspaceId },
				),
			)
			expect(added.status).toBe(200)

			const res = await createSessionsApp(agentId).request(ask(second.id, workspaceId))

			expect(res.status).toBe(200)
			const chats = await directChatRows()
			expect(chats).toHaveLength(1)
			expect(chats[0]?.conversationId).not.toBe(dm.conversationId)
			expect(await messagesFor(dm.conversationId)).toHaveLength(1)
			expect(await messagesFor(chats[0]?.conversationId as string)).toHaveLength(1)
		})

		it('still refuses with a 409 when no person can be found to ask', async () => {
			// An agent-owned workspace with a run an agent started: no human to resolve.
			const owner = await insertActor(db, { type: 'agent' })
			if (!owner) throw new Error('failed to seed owner')
			const ws = await insertWorkspace(db, owner.id)
			if (!ws) throw new Error('failed to seed workspace')
			const session = await insertSession(db, ws.id, owner.id, owner.id, {
				interactive: false,
				status: 'running',
			})
			if (!session) throw new Error('failed to seed session')

			const res = await createSessionsApp(owner.id).request(ask(session.id, ws.id))
			expect(res.status).toBe(409)
			expect(await directChatRows(ws.id)).toEqual([])
		})
	})

	describe('routing marker', () => {
		async function questionMetadata(chat: string) {
			const [row] = await messagesFor(chat)
			return (row?.metadata as { question?: { reply_to_session?: boolean; routed_to?: string } })
				.question
		}

		it("marks a chat session's question session_chat and not a reply to the session", async () => {
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId,
				status: 'running',
			})
			if (!session) throw new Error('failed to seed session')

			const res = await createSessionsApp(agentId).request(ask(session.id, workspaceId))
			expect(((await res.json()) as { delivered_to: string }).delivered_to).toBe('chat')

			const question = await questionMetadata(conversationId)
			expect(question?.routed_to).toBe('session_chat')
			expect(question?.reply_to_session).toBeUndefined()
			expect(await directChatRows()).toEqual([])
		})

		it("marks a helper's question helper_chat, a reply to the session, and waits on the person", async () => {
			const session = await insertSession(db, workspaceId, agentId, humanId, {
				interactive: true,
				conversationId: null,
				status: 'running',
				config: { ask_conversation_id: conversationId },
			})
			if (!session) throw new Error('failed to seed session')

			const res = await createSessionsApp(agentId).request(ask(session.id, workspaceId))
			expect(((await res.json()) as { delivered_to: string }).delivered_to).toBe('chat')

			const question = await questionMetadata(conversationId)
			expect(question?.routed_to).toBe('helper_chat')
			expect(question?.reply_to_session).toBe(true)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect((row?.config as { awaiting?: unknown }).awaiting).toBeDefined()
			expect(await directChatRows()).toEqual([])
		})
	})

	it('refuses a caller who is not the agent running the session', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		// A workspace member's own key must not be able to post a question in
		// another agent's name — the bubble is rendered as that agent speaking.
		const app = createSessionsApp(humanId)

		const res = await app.request(ask(session.id, workspaceId))
		expect(res.status).toBe(403)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('404s an unknown session', async () => {
		const app = createSessionsApp(agentId)
		const res = await app.request(ask('00000000-0000-0000-0000-000000000000', workspaceId))
		expect(res.status).toBe(404)
	})

	it('rejects a malformed question set', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		// One option is not a choice; the schema requires at least two.
		const res = await app.request(
			ask(session.id, workspaceId, {
				questions: [{ ...QUESTIONS[0], options: [{ label: 'Only one' }] }],
			}),
		)
		expect(res.status).toBe(400)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})
})
