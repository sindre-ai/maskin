import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, integrations, messages, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { buildIntegration, insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * POST /sessions/:id/connect-card — the route the `connect_integration` MCP
 * tool posts to when it runs inside a chat session.
 *
 * Against real Postgres because the behaviour under test is a write plus a read
 * of live state: the card has to land as a real `messages` row carrying the
 * backend-owned `metadata.integration_connect` marker, and "already connected"
 * has to be decided from the `integrations` table, not from anything cached.
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

function connectCard(sessionId: string, workspaceId: string, provider = 'linear') {
	return jsonRequest(
		'POST',
		`/api/sessions/${sessionId}/connect-card`,
		{ provider },
		{ 'X-Workspace-Id': workspaceId },
	)
}

describe('POST /sessions/:id/connect-card', () => {
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

	it('posts the card into the conversation as the agent', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(connectCard(session.id, workspaceId))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { posted: boolean; message_id?: number }
		expect(body.posted).toBe(true)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		const metadata = rows[0]?.metadata as {
			integration_connect?: { session_id: string; provider: string }
		}
		expect(metadata.integration_connect).toEqual({ session_id: session.id, provider: 'linear' })
		// The markdown fallback is what every non-chat reader shows, so it has to
		// name the provider as a human would, not by its registry key.
		expect(rows[0]?.content).toContain('Linear')
	})

	it('posts nothing when the provider is already connected in the workspace', async () => {
		const session = await chatSession()
		await db
			.insert(integrations)
			.values(buildIntegration({ workspaceId, provider: 'linear', createdBy: humanId }))
		const app = createSessionsApp(agentId)

		const res = await app.request(connectCard(session.id, workspaceId))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ posted: false, already_connected: true })
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('still posts the card for a multi-install provider that is already connected', async () => {
		// GitHub can have one install per org: "already connected" does not mean there
		// is nothing to offer. The card renders Connected beside "+ Add another".
		const session = await chatSession()
		await db
			.insert(integrations)
			.values(buildIntegration({ workspaceId, provider: 'github', createdBy: humanId }))
		const app = createSessionsApp(agentId)

		const res = await app.request(connectCard(session.id, workspaceId, 'github'))
		expect(res.status).toBe(200)
		expect(((await res.json()) as { posted: boolean }).posted).toBe(true)
		expect(await messagesFor(conversationId)).toHaveLength(1)
	})

	it('still posts the card when the only existing integration is not active', async () => {
		// A revoked row is not a connection. Treating it as one would tell the agent
		// "already connected" while every tool call fails — the live-status rule.
		const session = await chatSession()
		await db.insert(integrations).values(
			buildIntegration({
				workspaceId,
				provider: 'linear',
				status: 'revoked',
				createdBy: humanId,
			}),
		)
		const app = createSessionsApp(agentId)

		const res = await app.request(connectCard(session.id, workspaceId))
		expect(res.status).toBe(200)
		expect(((await res.json()) as { posted: boolean }).posted).toBe(true)
		expect(await messagesFor(conversationId)).toHaveLength(1)
	})

	it('400s a provider that is not in the registry', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(connectCard(session.id, workspaceId, 'not-a-provider'))
		expect(res.status).toBe(400)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses an autonomous session — there is nobody to show a card to', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: false,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		// The MCP tool reads this 409 as "fall back to the URL flow".
		const res = await app.request(connectCard(session.id, workspaceId))
		expect(res.status).toBe(409)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses an interactive session with no conversation attached', async () => {
		const session = await insertSession(db, workspaceId, agentId, humanId, {
			interactive: true,
			conversationId: null,
			status: 'running',
		})
		if (!session) throw new Error('failed to seed session')
		const app = createSessionsApp(agentId)

		const res = await app.request(connectCard(session.id, workspaceId))
		expect(res.status).toBe(409)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses a caller who is not the agent running the session', async () => {
		const session = await chatSession()
		// A workspace member's own key must not be able to post a card in another
		// agent's name — the bubble is rendered as that agent speaking.
		const app = createSessionsApp(humanId)

		const res = await app.request(connectCard(session.id, workspaceId))
		expect(res.status).toBe(403)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('404s an unknown session', async () => {
		const app = createSessionsApp(agentId)
		const res = await app.request(connectCard('00000000-0000-0000-0000-000000000000', workspaceId))
		expect(res.status).toBe(404)
	})
})
