import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, messages, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { routeThreadReplyToSubSession } from '../../services/thread-reply-routing'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

// A reply posted in the thread under a message that a sub-chat hangs from reaches that
// sub-chat's agent. Real Postgres, so the lookup of the sub-chat by its anchor message
// (sessions.spawned_by_message_id, no conversation of its own) is covered too.

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function makeSessionManager() {
	return {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
}

function appFor(actorId: string, sessionManager: ReturnType<typeof makeSessionManager>) {
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
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return app
}

describe('Thread replies reach the sub-chat in the thread', () => {
	let ownerId: string
	let replierId: string
	let agentId: string
	let workspaceId: string
	let conversationId: string
	let rootId: number
	let sessionManager: ReturnType<typeof makeSessionManager>
	const ws = () => ({ 'x-workspace-id': workspaceId })

	async function reply(actor: string, body: Record<string, unknown>) {
		return appFor(actor, sessionManager).request(
			jsonRequest('POST', `/api/conversations/${conversationId}/messages`, body, ws()),
		)
	}

	function subChat(overrides: Record<string, unknown> = {}) {
		return insertSession(db, workspaceId, agentId, ownerId, {
			interactive: true,
			status: 'running',
			conversationId: null,
			spawnedByMessageId: rootId,
			...overrides,
		})
	}

	beforeEach(async () => {
		sessionManager = makeSessionManager()
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		const replier = await insertActor(db, { type: 'human' })
		replierId = replier.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: replierId, role: 'member' })
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		const created = await appFor(ownerId, sessionManager).request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Pipeline', participant_actor_ids: [replierId], initial_message: 'kick off' },
				ws(),
			),
		)
		conversationId = ((await created.json()) as { id: string }).id
		const [root] = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
		rootId = root?.id as number
		sessionManager.writeInput.mockClear()
	})

	it('writes the reply into a running sub-chat', async () => {
		const session = await subChat()
		const res = await reply(replierId, {
			content: 'also check the invoices',
			thread_root_id: rootId,
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as { delivered_to_session?: Record<string, unknown> }
		expect(body.delivered_to_session).toEqual({ mode: 'live', session_id: session?.id })
		expect(sessionManager.writeInput).toHaveBeenCalledTimes(1)
		expect(sessionManager.writeInput).toHaveBeenCalledWith(
			session?.id,
			{ type: 'user', message: { role: 'user', content: 'also check the invoices' } },
			undefined,
			undefined,
			{ maskin_actor_id: replierId },
		)
	})

	it('still posts the reply in the thread', async () => {
		await subChat()
		const res = await reply(replierId, {
			content: 'also check the invoices',
			thread_root_id: rootId,
		})
		const posted = (await res.json()) as { id: number }
		const [row] = await db.select().from(messages).where(eq(messages.id, posted.id))
		expect(row?.threadRootId).toBe(rootId)
	})

	it('goes to the newest sub-chat of the thread', async () => {
		await subChat({ status: 'completed', createdAt: new Date(Date.now() - 60_000) })
		const newest = await subChat()
		const res = await reply(replierId, { content: 'next', thread_root_id: rootId })
		const body = (await res.json()) as { delivered_to_session?: { session_id: string } }
		expect(body.delivered_to_session?.session_id).toBe(newest?.id)
	})

	it('says so, and still posts, when the sub-chat cannot take a message yet', async () => {
		const session = await subChat({ status: 'starting' })
		const res = await reply(replierId, { content: 'hello?', thread_root_id: rootId })
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			delivered_to_session?: { mode: string; session_id: string; reason: string }
		}
		expect(body.delivered_to_session).toMatchObject({
			mode: 'not_delivered',
			session_id: session?.id,
		})
		expect(body.delivered_to_session?.reason).toMatch(/starting/)
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('reports a failed write instead of failing the post', async () => {
		await subChat()
		sessionManager.writeInput.mockRejectedValueOnce(new Error('stdin closed'))
		const res = await reply(replierId, { content: 'hello?', thread_root_id: rootId })
		expect(res.status).toBe(201)
		const body = (await res.json()) as { delivered_to_session?: { mode: string; reason: string } }
		expect(body.delivered_to_session).toMatchObject({
			mode: 'not_delivered',
			reason: 'stdin closed',
		})
	})

	it('leaves a top-level message alone even when a sub-chat hangs from it', async () => {
		await subChat()
		const res = await reply(replierId, { content: 'a new top-level message' })
		expect(res.status).toBe(201)
		const body = (await res.json()) as { delivered_to_session?: unknown }
		expect(body.delivered_to_session).toBeUndefined()
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('does nothing when the thread holds no sub-chat', async () => {
		const res = await reply(replierId, { content: 'just people talking', thread_root_id: rootId })
		expect(res.status).toBe(201)
		const body = (await res.json()) as { delivered_to_session?: unknown }
		expect(body.delivered_to_session).toBeUndefined()
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('ignores a chat session of the same conversation hung from the same message', async () => {
		await subChat({ conversationId })
		const res = await reply(replierId, { content: 'hi', thread_root_id: rootId })
		const body = (await res.json()) as { delivered_to_session?: unknown }
		expect(body.delivered_to_session).toBeUndefined()
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('does not feed the sub-chat its own agent’s words back', async () => {
		await subChat()
		await db.insert(conversationParticipants).values({ conversationId, actorId: agentId })
		const res = await reply(agentId, { content: 'working on it', thread_root_id: rootId })
		expect(res.status).toBe(201)
		const body = (await res.json()) as { delivered_to_session?: unknown }
		expect(body.delivered_to_session).toBeUndefined()
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('starts a follow-up when the sub-chat has ended', async () => {
		const ended = await subChat({ status: 'completed' })
		if (!ended) throw new Error('no session')
		const continueSession = vi.fn().mockResolvedValue({ sessionId: 'follow-up-id' })
		const delivery = await routeThreadReplyToSubSession(
			{ db, sessionManager: sessionManager as unknown as SessionManager, continueSession },
			{ workspaceId, rootMessageId: rootId, actorId: replierId, content: 'one more thing' },
		)
		expect(delivery).toEqual({
			mode: 'continued',
			session_id: 'follow-up-id',
			previous_session_id: ended.id,
		})
		expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ id: ended.id }), {
			workspaceId,
			actorId: replierId,
			content: 'one more thing',
		})
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('reports it when the follow-up cannot be started', async () => {
		await subChat({ status: 'failed' })
		const continueSession = vi.fn().mockRejectedValue(new Error('over the cap'))
		const delivery = await routeThreadReplyToSubSession(
			{ db, sessionManager: sessionManager as unknown as SessionManager, continueSession },
			{ workspaceId, rootMessageId: rootId, actorId: replierId, content: 'again' },
		)
		expect(delivery).toMatchObject({ mode: 'not_delivered', reason: 'over the cap' })
	})
})
