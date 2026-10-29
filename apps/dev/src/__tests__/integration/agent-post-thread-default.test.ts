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
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string, actorType: 'human' | 'agent') {
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
	return app
}

type Msg = { id: number; threadRootId: number | null }

/**
 * An agent's mid-turn post_conversation_message lands where the human is talking: in the thread
 * of the message that started the turn, the same lookup the end-of-turn reply uses.
 */
describe('Agent post defaults to the turn thread', () => {
	let humanId: string
	let agentId: string
	let workspaceId: string
	let conversationId: string
	let rootId: number
	let replyId: number
	const ws = () => ({ 'x-workspace-id': workspaceId })

	async function seedSession(overrides: Record<string, unknown> = {}) {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
			...overrides,
		})
		if (!session) throw new Error('failed to seed session')
		return session
	}

	/** The user-turn envelope SessionManager.writeInput persists, tagged with the message id. */
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

	async function post(
		actor: { id: string; type: 'human' | 'agent' },
		body: Record<string, unknown>,
	) {
		const res = await appFor(actor.id, actor.type).request(
			jsonRequest('POST', `/api/conversations/${conversationId}/messages`, body, ws()),
		)
		expect(res.status).toBe(201)
		return (await res.json()) as Msg
	}

	beforeEach(async () => {
		humanId = getTestActorId()
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		const w = await insertWorkspace(db, humanId)
		workspaceId = w.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agentId, role: 'member' })
		const created = await appFor(humanId, 'human').request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Chat', participant_actor_ids: [agentId], initial_message: 'status?' },
				ws(),
			),
		)
		conversationId = ((await created.json()) as { id: string }).id
		const [root] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		rootId = root?.id as number
		const reply = await post(
			{ id: humanId, type: 'human' },
			{
				content: 'in the thread',
				thread_root_id: rootId,
			},
		)
		replyId = reply.id
	})

	it('posts into the thread when the turn was started by a thread reply', async () => {
		const session = await seedSession()
		await startTurn(session.id, replyId)

		const posted = await post(
			{ id: agentId, type: 'agent' },
			{ content: 'looking into it', session_id: session.id },
		)
		expect(posted.threadRootId).toBe(rootId)
	})

	it('posts top-level when the turn was started by a top-level message', async () => {
		const session = await seedSession()
		await startTurn(session.id, rootId)

		const posted = await post(
			{ id: agentId, type: 'agent' },
			{ content: 'looking into it', session_id: session.id },
		)
		expect(posted.threadRootId).toBeNull()
	})

	it('posts top-level when the session has no tagged turn yet', async () => {
		const session = await seedSession()

		const posted = await post(
			{ id: agentId, type: 'agent' },
			{ content: 'looking into it', session_id: session.id },
		)
		expect(posted.threadRootId).toBeNull()
	})

	it('follows the newest turn of a long-lived session', async () => {
		const session = await seedSession()
		await startTurn(session.id, replyId)
		await startTurn(session.id, rootId)

		const posted = await post(
			{ id: agentId, type: 'agent' },
			{ content: 'looking into it', session_id: session.id },
		)
		expect(posted.threadRootId).toBeNull()
	})

	it('lets an explicit thread_root_id win over the turn thread', async () => {
		const session = await seedSession()
		await startTurn(session.id, replyId)
		const other = await post({ id: humanId, type: 'human' }, { content: 'another topic' })

		const posted = await post(
			{ id: agentId, type: 'agent' },
			{ content: 'over here', session_id: session.id, thread_root_id: other.id },
		)
		expect(posted.threadRootId).toBe(other.id)
	})

	it('posts to the main timeline with top_level: true', async () => {
		const session = await seedSession()
		await startTurn(session.id, replyId)

		const posted = await post(
			{ id: agentId, type: 'agent' },
			{ content: 'for everyone', session_id: session.id, top_level: true },
		)
		expect(posted.threadRootId).toBeNull()
	})

	it('leaves a post with no session id top-level', async () => {
		const session = await seedSession()
		await startTurn(session.id, replyId)

		const posted = await post({ id: agentId, type: 'agent' }, { content: 'no session' })
		expect(posted.threadRootId).toBeNull()
	})

	it("ignores another agent's session id", async () => {
		const otherAgent = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: otherAgent.id, role: 'member' })
		await db.insert(conversationParticipants).values({ conversationId, actorId: otherAgent.id })
		const session = await seedSession()
		await startTurn(session.id, replyId)

		const posted = await post(
			{ id: otherAgent.id, type: 'agent' },
			{ content: 'borrowed session', session_id: session.id },
		)
		expect(posted.threadRootId).toBeNull()
	})

	it('leaves a human caller unchanged even with a session id', async () => {
		const session = await seedSession()
		await startTurn(session.id, replyId)

		const posted = await post(
			{ id: humanId, type: 'human' },
			{ content: 'a person typing', session_id: session.id },
		)
		expect(posted.threadRootId).toBeNull()
	})
})
