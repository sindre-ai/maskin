import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { masterChats, messages } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { ensureWorkspaceMember, insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * Tapping an option on a question an agent asked in its master chat. The session that asked has
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

/** The agent asks from a finished run that an agent started, so its question lands in the master chat. */
async function askFromEndedSession(s: Awaited<ReturnType<typeof setup>>) {
	const session = await insertSession(db, s.workspaceId, s.agent.id, s.agent.id, {
		interactive: false,
		status: 'completed',
	})
	if (!session) throw new Error('failed to seed session')
	const asked = await appFor(s.agent.id, 'agent').app.request(
		post(`/api/sessions/${session.id}/ask`, s.workspaceId, { questions: QUESTIONS }),
	)
	expect(asked.status).toBe(200)
	const { message_id } = (await asked.json()) as { message_id: number }
	const [master] = await db
		.select()
		.from(masterChats)
		.where(eq(masterChats.workspaceId, s.workspaceId))
	if (!master) throw new Error('no master chat was created')
	return { session, questionId: message_id, conversationId: master.conversationId }
}

const chatMessages = (conversationId: string) =>
	db.select().from(messages).where(eq(messages.conversationId, conversationId))

describe('POST /sessions/:id/input on a master-chat question', () => {
	it('records the answer in the chat and gives the asking agent a turn, without resuming the ended session', async () => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromEndedSession(s)
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
		// The agent gets its turn in the master chat, with the chat so far.
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
		const { session, questionId, conversationId } = await askFromEndedSession(s)
		const { app } = appFor(s.humanId, 'human')
		const tap = () =>
			app.request(post(`/api/sessions/${session.id}/input`, s.workspaceId, answerBody(questionId)))

		expect((await tap()).status).toBe(200)
		expect((await tap()).status).toBe(409)
		expect(await chatMessages(conversationId)).toHaveLength(2)
	})

	it('leaves a person who is not in the master chat on the old path, which refuses an ended session', async () => {
		const s = await setup()
		const { session, questionId, conversationId } = await askFromEndedSession(s)
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

		// Plain text, and an answer that points at no master-chat question: both go to the session.
		for (const body of [{ content: 'carry on' }, answerBody(987654)]) {
			const res = await app.request(post(`/api/sessions/${session.id}/input`, s.workspaceId, body))
			expect(res.status).toBe(200)
		}

		expect(sessionManager.writeInput).toHaveBeenCalledTimes(2)
		expect(sessionManager.writeInput.mock.calls.every((call) => call[0] === session.id)).toBe(true)
		expect(sessionManager.createSession).not.toHaveBeenCalled()
		expect(
			await db.select().from(masterChats).where(eq(masterChats.workspaceId, s.workspaceId)),
		).toEqual([])
	})
})
