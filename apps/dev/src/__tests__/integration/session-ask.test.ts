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

	it('refuses an autonomous session — there is nobody to ask', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		const res = await app.request(ask(session.id, workspaceId))
		expect(res.status).toBe(409)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses an interactive session with no conversation attached', async () => {
		// Interactive alone is not enough: a session started from the sessions UI
		// has a live stdin but no chat surface to render options on.
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId: null,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		const res = await app.request(ask(session.id, workspaceId))
		expect(res.status).toBe(409)
		expect(await messagesFor(conversationId)).toHaveLength(0)
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
