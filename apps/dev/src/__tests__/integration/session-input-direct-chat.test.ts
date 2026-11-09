import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationParticipants, conversations, messages } from '@maskin/db/schema'
import { and, eq, isNotNull } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { ensureWorkspaceMember, insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * Tapping an option on a question an agent asked in its direct message with the person. The session that asked has
 * usually ended, or an agent started it, so the answer cannot be typed into it: it is recorded in
 * the chat and the asking agent gets a turn there. Real Postgres, because the claims are rows:
 * the answer message, and that no turn was written into the finished session.
 */

function appFor(actorId: string, actorType: 'human' | 'agent') {
	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
	}
	configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })

	const app = new OpenAPIHono<{
		Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
	}>({
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
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	return { app, sessionManager }
}

const QUESTIONS = [
	{
		question: 'How should I reach Spotify?',
		header: 'Spotify access',
		multi_select: false,
		options: [{ label: 'API token' }, { label: 'No login' }],
	},
]

const ANSWER = '**Spotify access** — How should I reach Spotify?\nAPI token'

const answerBody = (questionMessageId: number) => ({
	content: ANSWER,
	question_answer: {
		question_message_id: questionMessageId,
		answers: [{ header: 'Spotify access', selected: ['API token'] }],
	},
})

const post = (path: string, workspaceId: string, body: unknown) =>
	jsonRequest('POST', path, body, { 'X-Workspace-Id': workspaceId })

async function setup() {
	const humanId = getTestActorId()
	const workspace = await insertWorkspace(db, humanId)
	const agent = await insertActor(db, { type: 'agent' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	return { humanId, workspaceId: workspace.id, agent }
}

/**
 * The agent asks from a run with no chat of its own, so its question lands in the direct message.
 * By default the run is finished and an agent started it; pass other options for the other shapes.
 */
async function askFromSession(
	s: Awaited<ReturnType<typeof setup>>,
	opts: { createdBy?: string; status?: string } = {},
) {
	const session = await insertSession(db, s.workspaceId, s.agent.id, opts.createdBy ?? s.agent.id, {
		interactive: false,
		status: opts.status ?? 'completed',
	})
	if (!session) throw new Error('failed to seed session')
	const asked = await appFor(s.agent.id, 'agent').app.request(
		post(`/api/sessions/${session.id}/ask`, s.workspaceId, { questions: QUESTIONS }),
	)
	expect(asked.status).toBe(200)
	const { message_id } = (await asked.json()) as { message_id: number }
	const [direct] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(
			and(eq(conversations.workspaceId, s.workspaceId), isNotNull(conversations.directPairKey)),
		)
	if (!direct) throw new Error('no direct message was created')
	return { session, questionId: message_id, conversationId: direct.id }
}

const chatMessages = (conversationId: string) =>
	db.select().from(messages).where(eq(messages.conversationId, conversationId))

describe('POST /sessions/:id/input on a direct-message question', () => {
	it('records the answer in the chat and gives the asking agent a turn, without resuming the ended session', async () => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromSession(s)
		const { app, sessionManager } = appFor(s.humanId, 'human')

		const res = await app.request(
			post(`/api/sessions/${session.id}/input`, s.workspaceId, answerBody(questionId)),
		)

		expect(res.status).toBe(200)
		const rows = await chatMessages(conversationId)
		expect(rows).toHaveLength(2)
		expect(rows[1]).toMatchObject({ actorId: s.humanId, content: ANSWER })
		expect(rows[1]?.metadata).toMatchObject({
			question_answer: { question_message_id: questionId },
		})
		// The agent gets its turn in the direct message, with the chat so far.
		expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		const [, params] = sessionManager.createSession.mock.calls[0] as unknown as [
			string,
			{ actorId: string; actionPrompt: string },
		]
		expect(params.actorId).toBe(s.agent.id)
		expect(params.actionPrompt).toContain('API token')
		// The finished session is not written to.
		expect(sessionManager.writeInput.mock.calls.filter((call) => call[0] === session.id)).toEqual(
			[],
		)
	})

	it('refuses a second answer to the same question', async () => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromSession(s)
		const { app, sessionManager } = appFor(s.humanId, 'human')
		const tap = () =>
			app.request(post(`/api/sessions/${session.id}/input`, s.workspaceId, answerBody(questionId)))

		expect((await tap()).status).toBe(200)
		expect((await tap()).status).toBe(409)
		expect(await chatMessages(conversationId)).toHaveLength(2)
		expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
	})

	it.each([
		['a finished run the person started', 'person', 'completed'],
		['a run an agent started, still running', 'agent', 'running'],
	] as const)('takes a tap on %s', async (_label, startedBy, status) => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromSession(s, {
			createdBy: startedBy === 'person' ? s.humanId : s.agent.id,
			status,
		})
		const { app, sessionManager } = appFor(s.humanId, 'human')

		const res = await app.request(
			post(`/api/sessions/${session.id}/input`, s.workspaceId, answerBody(questionId)),
		)

		expect(res.status).toBe(200)
		expect(await chatMessages(conversationId)).toHaveLength(2)
		expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		expect(sessionManager.writeInput.mock.calls.filter((call) => call[0] === session.id)).toEqual(
			[],
		)
	})

	it('leaves a question in a topical chat of the same two people on the old path', async () => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromSession(s)
		// The same question, as if it had been posted in a chat with no direct pair key.
		const [question] = await chatMessages(conversationId)
		const [topical] = await db
			.insert(conversations)
			.values({ workspaceId: s.workspaceId, title: 'Pricing', createdBy: s.humanId })
			.returning({ id: conversations.id })
		if (!question || !topical) throw new Error('failed to seed topical chat')
		await db.insert(conversationParticipants).values([
			{ conversationId: topical.id, actorId: s.humanId },
			{ conversationId: topical.id, actorId: s.agent.id },
		])
		await db.update(messages).set({ conversationId: topical.id }).where(eq(messages.id, questionId))
		const { app, sessionManager } = appFor(s.humanId, 'human')

		const res = await app.request(
			post(`/api/sessions/${session.id}/input`, s.workspaceId, answerBody(questionId)),
		)

		expect(res.status).toBe(409)
		expect(await chatMessages(topical.id)).toHaveLength(1)
		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})

	it('leaves a person who is not in the direct message on the old path, which refuses an ended session', async () => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromSession(s)
		const stranger = await insertActor(db, { type: 'human' })
		await ensureWorkspaceMember(db, s.workspaceId, stranger.id)
		const { app, sessionManager } = appFor(stranger.id, 'human')

		const res = await app.request(
			post(`/api/sessions/${session.id}/input`, s.workspaceId, answerBody(questionId)),
		)

		expect(res.status).toBe(409)
		expect(await chatMessages(conversationId)).toHaveLength(1)
		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})

	it('does not change what an ordinary running session does with input', async () => {
		const s = await setup()
		const session = await insertSession(db, s.workspaceId, s.agent.id, s.humanId, {
			interactive: true,
			status: 'running',
			conversationId: null,
		})
		if (!session) throw new Error('failed to seed session')
		const { app, sessionManager } = appFor(s.humanId, 'human')

		// Plain text, and an answer that points at no direct-message question: both go to the session.
		for (const body of [{ content: 'carry on' }, answerBody(987654)]) {
			const res = await app.request(post(`/api/sessions/${session.id}/input`, s.workspaceId, body))
			expect(res.status).toBe(200)
		}

		expect(sessionManager.writeInput).toHaveBeenCalledTimes(2)
		expect(sessionManager.writeInput.mock.calls.every((call) => call[0] === session.id)).toBe(true)
		expect(sessionManager.createSession).not.toHaveBeenCalled()
		expect(
			await db
				.select()
				.from(conversations)
				.where(
					and(eq(conversations.workspaceId, s.workspaceId), isNotNull(conversations.directPairKey)),
				),
		).toEqual([])
	})
})
