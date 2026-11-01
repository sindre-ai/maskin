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
 * POST /sessions/:id/keychain-card — the route the `request_keychain_credential`
 * MCP tool posts to when it runs inside a chat session.
 *
 * Against real Postgres because the behaviour under test is a write: the card has to
 * land as a real `messages` row carrying the backend-owned `metadata.keychain_request`
 * marker, authored by the agent, and never carry anything secret.
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

function keychainCard(sessionId: string, workspaceId: string, body: Record<string, unknown>) {
	return jsonRequest('POST', `/api/sessions/${sessionId}/keychain-card`, body, {
		'X-Workspace-Id': workspaceId,
	})
}

describe('POST /sessions/:id/keychain-card', () => {
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

	it('posts the card into the conversation as the agent, carrying kind, name and hint', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			keychainCard(session.id, workspaceId, {
				kind: 'login',
				suggested_name: 'e-conomic',
				hint: 'To read invoices.',
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { posted: boolean; message_id: number }
		expect(body.posted).toBe(true)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		expect(rows[0]?.id).toBe(body.message_id)
		expect(
			(rows[0]?.metadata as { keychain_request?: Record<string, unknown> }).keychain_request,
		).toEqual({
			session_id: session.id,
			kind: 'login',
			suggested_name: 'e-conomic',
			hint: 'To read invoices.',
		})
		// The markdown fallback is what every non-chat reader shows.
		expect(rows[0]?.content).toContain('e-conomic')
		expect(rows[0]?.content).toContain('login')
	})

	it('stores only what it was given: no suggested name or hint when none was sent', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(keychainCard(session.id, workspaceId, { kind: 'api_key' }))
		expect(res.status).toBe(200)

		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { keychain_request?: Record<string, unknown> }).keychain_request,
		).toEqual({ session_id: session.id, kind: 'api_key' })
	})

	it('stores the named target agents with their names, and ignores unknown, non-agent and outside ids', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)
		const target = await insertActor(db, { type: 'agent', name: 'Infra & DevOps' })
		if (!target) throw new Error('failed to seed target agent')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: target.id, role: 'member' })
		const outsider = await insertActor(db, { type: 'agent' })
		if (!outsider) throw new Error('failed to seed outside agent')

		const res = await app.request(
			keychainCard(session.id, workspaceId, {
				kind: 'api_key',
				target_agent_ids: [
					target.id,
					target.id,
					humanId,
					outsider.id,
					'not-a-uuid',
					'00000000-0000-0000-0000-000000000000',
				],
			}),
		)
		expect(res.status).toBe(200)

		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { keychain_request?: Record<string, unknown> }).keychain_request,
		).toEqual({
			session_id: session.id,
			kind: 'api_key',
			target_agents: [{ id: target.id, name: 'Infra & DevOps' }],
		})
	})

	it('posts the card with no target_agents when none of the ids are valid', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			keychainCard(session.id, workspaceId, { kind: 'api_key', target_agent_ids: ['nope'] }),
		)
		expect(res.status).toBe(200)

		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { keychain_request?: Record<string, unknown> }).keychain_request,
		).toEqual({ session_id: session.id, kind: 'api_key' })
	})

	it('rejects a kind it does not know', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(keychainCard(session.id, workspaceId, { kind: 'password' }))
		expect(res.status).toBe(400)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses a session that belongs to a different actor', async () => {
		const session = await chatSession()
		const other = await insertActor(db, { type: 'agent' })
		if (!other) throw new Error('failed to seed agent')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })
		const app = createSessionsApp(other.id)

		const res = await app.request(keychainCard(session.id, workspaceId, { kind: 'api_key' }))
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

		const res = await app.request(keychainCard(session.id, workspaceId, { kind: 'api_key' }))
		expect(res.status).toBe(409)
	})
})
