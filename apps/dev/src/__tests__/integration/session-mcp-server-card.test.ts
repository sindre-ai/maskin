import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversations, messages, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * POST /sessions/:id/mcp-server-card: the route the `add_mcp_server` MCP tool posts to when it
 * runs inside a chat session.
 *
 * Against real Postgres because the behaviour under test is a write: the card has to land as a
 * real `messages` row authored by the agent, carrying the backend-owned
 * `metadata.mcp_server_request` marker, and never a secret.
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

function mcpServerCard(sessionId: string, workspaceId: string, body: Record<string, unknown>) {
	return jsonRequest('POST', `/api/sessions/${sessionId}/mcp-server-card`, body, {
		'X-Workspace-Id': workspaceId,
	})
}

const LINEAR = {
	name: 'Linear',
	hint: 'To read your issues.',
	command: 'npx',
	args: ['-y', '@linear/mcp-server'],
	env: { REGION: 'eu' },
	secret_env: ['LINEAR_API_KEY'],
}

describe('POST /sessions/:id/mcp-server-card', () => {
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

	it('posts the card as the agent, with the definition and the names of the secrets', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(mcpServerCard(session.id, workspaceId, LINEAR))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { posted: boolean; message_id: number }
		expect(body.posted).toBe(true)

		const rows = await messagesFor(conversationId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(agentId)
		expect(rows[0]?.sessionId).toBe(session.id)
		expect(rows[0]?.id).toBe(body.message_id)
		expect(
			(rows[0]?.metadata as { mcp_server_request?: Record<string, unknown> }).mcp_server_request,
		).toEqual({
			session_id: session.id,
			name: 'Linear',
			hint: 'To read your issues.',
			command: 'npx',
			args: ['-y', '@linear/mcp-server'],
			env: { REGION: 'eu' },
			secret_env: ['LINEAR_API_KEY'],
		})
		expect(rows[0]?.content).toContain('**Linear**')
	})

	it('accepts a remote server with a secret header', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			mcpServerCard(session.id, workspaceId, {
				name: 'Linear',
				url: 'https://mcp.linear.app/mcp',
				secret_headers: ['Authorization'],
			}),
		)

		expect(res.status).toBe(200)
		const rows = await messagesFor(conversationId)
		expect(
			(rows[0]?.metadata as { mcp_server_request?: { url: string; secret_headers: string[] } })
				.mcp_server_request,
		).toMatchObject({ url: 'https://mcp.linear.app/mcp', secret_headers: ['Authorization'] })
	})

	it('accepts a Keychain reference as a value under a secret-looking name', async () => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(
			mcpServerCard(session.id, workspaceId, {
				name: 'Linear',
				command: 'npx',
				env: { LINEAR_API_KEY: '${KEYCHAIN_BYO_APIKEY_LINEAR}' },
			}),
		)

		expect(res.status).toBe(200)
	})

	it.each([
		['no command or url', { name: 'Linear' }],
		['a name that is both a value and a secret', { ...LINEAR, env: { LINEAR_API_KEY: 'abc' } }],
		['a key in args', { name: 'Linear', command: 'npx', args: ['--api-key', 'sk_live_123'] }],
		['a key in an arg value', { name: 'Linear', command: 'npx', args: ['--token=abc123'] }],
		['an env name that is not valid', { ...LINEAR, secret_env: ['not valid'] }],
		['both a command and a url', { ...LINEAR, url: 'https://mcp.linear.app/mcp' }],
		['a key-looking env name with a literal value', { ...LINEAR, env: { API_TOKEN: 'abc123' } }],
		[
			'an Authorization header with a literal value',
			{
				name: 'Linear',
				url: 'https://mcp.linear.app/mcp',
				headers: { Authorization: 'Bearer abc' },
			},
		],
		['a url that is not http(s)', { name: 'Linear', url: 'file:///etc/passwd' }],
	])('rejects %s and posts nothing', async (_name, body) => {
		const session = await chatSession()
		const app = createSessionsApp(agentId)

		const res = await app.request(mcpServerCard(session.id, workspaceId, body))

		expect(res.status).toBe(400)
		expect(await messagesFor(conversationId)).toHaveLength(0)
	})

	it('refuses a session that belongs to a different actor', async () => {
		const session = await chatSession()
		const other = await insertActor(db, { type: 'agent' })
		if (!other) throw new Error('failed to seed agent')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })
		const app = createSessionsApp(other.id)

		const res = await app.request(mcpServerCard(session.id, workspaceId, LINEAR))

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

		const res = await app.request(mcpServerCard(session.id, workspaceId, LINEAR))

		expect(res.status).toBe(409)
	})
})
