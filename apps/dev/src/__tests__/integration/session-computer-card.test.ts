import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, messages, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * POST /sessions/:id/computer-card — the route the `show_computer` MCP tool posts to
 * when it runs inside a chat session.
 *
 * Against real Postgres because the behaviour under test is a write: the card has to
 * land as a real `messages` row authored by the agent (the author is what decides whose
 * computer the card opens), carrying the backend-owned `metadata.computer_request`
 * marker.
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

function computerCard(sessionId: string, workspaceId: string, body: Record<string, unknown>) {
	return jsonRequest('POST', `/api/sessions/${sessionId}/computer-card`, body, {
		'X-Workspace-Id': workspaceId,
	})
}

describe('POST /sessions/:id/computer-card', () => {
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

	async function chatSession() {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		return session
	}

	it('posts the card into the conversation as the agent, carrying the task', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			computerCard(session.id, workspaceId, { task: 'Approve the 2FA prompt on e-conomic.' }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { posted: boolean; message_id: number }
		expect(body.posted).toBe(true)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		// The author is the agent: the card opens the AUTHOR's computer.
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		expect(rows[0]?.id).toBe(body.message_id)
		expect(
			(rows[0]?.metadata as { computer_request?: Record<string, unknown> }).computer_request,
		).toEqual({ session_id: session.id, task: 'Approve the 2FA prompt on e-conomic.' })
		// The markdown fallback is what every non-chat reader shows.
		expect(rows[0]?.content).toContain('Approve the 2FA prompt on e-conomic.')
	})

	it('trims the task', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		await app.request(computerCard(session.id, workspaceId, { task: '  Log in.  ' }))

		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { computer_request?: { task: string } }).computer_request?.task,
		).toBe('Log in.')
	})

	it.each([
		['no task', {}],
		['an empty task', { task: '   ' }],
		['an over-long task', { task: 'x'.repeat(501) }],
	])('rejects %s and posts nothing', async (_name, body) => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(computerCard(session.id, workspaceId, body))

		expect(res.status).toBe(400)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses a session that belongs to a different actor', async () => {
		const session = await chatSession()
		const other = await insertActor(db, { type: 'agent' })
		if (!other) throw new Error('failed to seed agent')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })
		const app = createSessionsApp(other.id)

		const res = await app.request(computerCard(session.id, workspaceId, { task: 'Log in.' }))

		expect(res.status).toBe(403)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('answers 409 for a session with no chat, so the tool can say nobody is there to ask', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		const res = await app.request(computerCard(session.id, workspaceId, { task: 'Log in.' }))

		expect(res.status).toBe(409)
	})
})
