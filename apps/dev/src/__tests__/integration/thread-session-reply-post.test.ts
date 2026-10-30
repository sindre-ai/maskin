import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	messages,
	sessionLogs,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { track } = vi.hoisted(() => ({ track: vi.fn() }))

vi.mock('../../lib/analytics/chat-reply-events', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/chat-reply-events')>()),
	trackChatReplyPosted: track,
}))

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(createApiError('VALIDATION_ERROR', 'invalid', formatZodError(result.error)), 400),
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'agent')
		c.set('sessionManager', {})
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

type Reported = {
	sessionThreadRootId: number | null
	replyThreadRootId: number | null
	originThreadRootId: number | null
	originMessageId: number | null
	latencyMs: number | null
	path: string
	source: string
}

/**
 * A thread session's mid-turn post lands in its own thread, and each reply is reported as
 * chat_reply_posted with both thread ids, so the bet's success can be read from the event.
 */
describe('A thread session posting into the chat (Integration)', () => {
	let humanId: string
	let agentId: string
	let workspaceId: string
	let conversationId: string
	let rootId: number
	let replyId: number
	let mainMessageId: number

	async function seedThreadSession() {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
			threadRootId: rootId,
		})
		if (!session) throw new Error('failed to seed session')
		return session
	}

	async function startTurn(sessionId: string, messageId: number) {
		await db.insert(sessionLogs).values({
			sessionId,
			stream: 'stdout',
			content: `${JSON.stringify({
				type: 'user',
				message: { role: 'user', content: 'hello' },
				maskin_message_id: messageId,
			})}\n`,
		})
	}

	async function post(sessionId: string, extra: Record<string, unknown> = {}) {
		const res = await appFor(agentId).request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages`,
				{ content: 'on it', session_id: sessionId, ...extra },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as { id: number; threadRootId?: number | null }
	}

	const lastReported = () => track.mock.calls[track.mock.calls.length - 1]?.[0] as Reported

	beforeEach(async () => {
		vi.clearAllMocks()
		humanId = getTestActorId()
		agentId = (await insertActor(db, { type: 'agent' })).id
		workspaceId = (await insertWorkspace(db, humanId)).id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
		conversationId = (await insertConversation(db, workspaceId, humanId)).id
		await db.insert(conversationParticipants).values([
			{ conversationId, actorId: humanId },
			{ conversationId, actorId: agentId },
		])
		const insert = async (content: string, threadRootId: number | null) => {
			const [row] = await db
				.insert(messages)
				.values({ conversationId, actorId: humanId, content, threadRootId })
				.returning()
			if (!row) throw new Error('failed to insert message')
			return row.id
		}
		rootId = await insert('root', null)
		replyId = await insert('in the thread', rootId)
		mainMessageId = await insert('in the main chat', null)
	})

	it('posts into its thread and reports both thread ids on the session path', async () => {
		const session = await seedThreadSession()
		await startTurn(session.id, replyId)

		const posted = await post(session.id)

		const [row] = await db.select().from(messages).where(eq(messages.id, posted.id))
		expect(row?.threadRootId).toBe(rootId)
		await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
		expect(lastReported()).toMatchObject({
			sessionThreadRootId: rootId,
			replyThreadRootId: rootId,
			originThreadRootId: rootId,
			originMessageId: replyId,
			path: 'session',
			source: 'post',
		})
		expect(lastReported().latencyMs).toBeGreaterThanOrEqual(0)
	})

	it('posts into its thread even when the turn came from a main-chat message, reported as a fallback', async () => {
		const session = await seedThreadSession()
		await startTurn(session.id, mainMessageId)

		const posted = await post(session.id)

		const [row] = await db.select().from(messages).where(eq(messages.id, posted.id))
		expect(row?.threadRootId).toBe(rootId)
		await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
		expect(lastReported()).toMatchObject({
			sessionThreadRootId: rootId,
			replyThreadRootId: rootId,
			originThreadRootId: null,
			path: 'fallback',
		})
	})

	it('reports a main-chat session answering a main-chat message as the session path', async () => {
		const main = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!main) throw new Error('failed to seed session')
		await startTurn(main.id, mainMessageId)

		await post(main.id)

		await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))
		expect(lastReported()).toMatchObject({
			sessionThreadRootId: null,
			replyThreadRootId: null,
			originThreadRootId: null,
			path: 'session',
		})
	})
})
