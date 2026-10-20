import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, conversations, integrations, messages, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	grantedActorIds,
	insertActor,
	insertAgentGrant,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: grantsRoutes } = await import('../../routes/integrations-grants')

/**
 * An agent asks to use a credential that already exists: list_keychain_credentials ->
 * request_keychain_access (a card) -> the person allows it (a grant, then a restart).
 * Against real Postgres: each step is a write or a read that depends on grants and rows.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		workspaceRole?: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

const stopSession = vi.fn(async () => {})
const findActive = vi.fn(async () => null)

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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', {
			stopSession,
			findConversationSessionAnyActive: findActive,
			createSession: vi.fn(),
			writeInput: vi.fn(),
		} as unknown as Env['Variables']['sessionManager'])
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	app.route('/api/integrations', grantsRoutes as never)
	return app
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	const other = await insertActor(db, { type: 'agent' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: agent.id, role: 'member' },
		{ workspaceId: ws.id, actorId: other.id, role: 'member' },
	])
	const [conversation] = await db
		.insert(conversations)
		.values({ workspaceId: ws.id, title: 'Chat', createdBy: human })
		.returning()
	const session = await insertSession(db, ws.id, agent.id, human, {
		interactive: true,
		conversationId: conversation.id,
		status: 'running',
	})
	const key = async (name: string, mode: 'byo_apikey' | 'byo_login' = 'byo_apikey', over = {}) =>
		(
			await db
				.insert(integrations)
				.values({
					workspaceId: ws.id,
					provider: 'custom',
					providerMode: mode,
					displayName: name,
					status: 'active',
					credentials: 'x',
					defaultAgentAccess: 'none',
					createdBy: human,
					...over,
				})
				.returning()
		)[0]
	return { human, ws, agent, other, conversation, session, key }
}

const H = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

describe('GET /sessions/:id/keychain-credentials (Integration)', () => {
	it('lists saved keys and logins by name with whether this agent has each, never a value', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		await s.key('e-conomic', 'byo_login')
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: stripe.id,
			actorId: s.agent.id,
		})
		// Not listed: an undone key and an ordinary integration.
		await s.key('Undone', 'byo_apikey', { status: 'undone', credentials: null })
		await db.insert(integrations).values({
			workspaceId: s.ws.id,
			provider: 'slack',
			status: 'active',
			credentials: 'x',
			createdBy: s.human,
		})

		const res = await appFor(s.agent.id, 'agent').request(
			jsonRequest(
				'GET',
				`/api/sessions/${s.session.id}/keychain-credentials`,
				undefined,
				H(s.ws.id),
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { credentials: Array<Record<string, unknown>> }
		expect(body.credentials).toEqual([
			{ name: 'Stripe', kind: 'api_key', has_access: true, scope: 'always' },
			{ name: 'e-conomic', kind: 'login', has_access: false, scope: null },
		])
		expect(JSON.stringify(body)).not.toContain('"x"')
	})

	it('is refused for an agent that does not own the session', async () => {
		const s = await setup()
		const res = await appFor(s.other.id, 'agent').request(
			jsonRequest(
				'GET',
				`/api/sessions/${s.session.id}/keychain-credentials`,
				undefined,
				H(s.ws.id),
			),
		)
		expect(res.status).toBe(403)
	})
})

describe('POST /sessions/:id/keychain-access-card (Integration)', () => {
	const post = (s: Awaited<ReturnType<typeof setup>>, body: unknown, as = s.agent.id) =>
		appFor(as, 'agent').request(
			jsonRequest('POST', `/api/sessions/${s.session.id}/keychain-access-card`, body, H(s.ws.id)),
		)

	it('posts a card naming the credential, authored by the agent, holding no secret', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		const res = await post(s, { credential_name: 'stripe', hint: 'To read invoices.' })

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ posted: true, already_granted: false })
		const rows = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, s.conversation.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ actorId: s.agent.id })
		expect(rows[0].metadata).toEqual({
			keychain_access_request: {
				session_id: s.session.id,
				integration_id: stripe.id,
				credential_name: 'Stripe',
				kind: 'api_key',
				hint: 'To read invoices.',
			},
		})
		expect(rows[0].content).toContain('Stripe')
		// Asking is not granting.
		expect(await grantedActorIds(db, stripe.id)).toEqual([])
	})

	it('posts nothing when the agent already has it', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: stripe.id,
			actorId: s.agent.id,
		})
		const res = await post(s, { credential_name: 'Stripe' })
		expect(await res.json()).toMatchObject({ posted: false, already_granted: true })
		expect(
			await db.select().from(messages).where(eq(messages.conversationId, s.conversation.id)),
		).toEqual([])
	})

	it('answers 404 for a name that is not a saved credential, including an ordinary integration', async () => {
		const s = await setup()
		await db.insert(integrations).values({
			workspaceId: s.ws.id,
			provider: 'slack',
			displayName: 'Slack',
			status: 'active',
			credentials: 'x',
			createdBy: s.human,
		})
		expect((await post(s, { credential_name: 'Nope' })).status).toBe(404)
		expect((await post(s, { credential_name: 'Slack' })).status).toBe(404)
	})

	it('does not see a credential from another workspace', async () => {
		const s = await setup()
		const elsewhere = await setup()
		await elsewhere.key('Hidden')
		expect((await post(s, { credential_name: 'Hidden' })).status).toBe(404)
	})

	it('answers 409 when the session is not an interactive chat', async () => {
		const s = await setup()
		await s.key('Stripe')
		const autonomous = await insertSession(db, s.ws.id, s.agent.id, s.human, { status: 'running' })
		const res = await appFor(s.agent.id, 'agent').request(
			jsonRequest(
				'POST',
				`/api/sessions/${autonomous.id}/keychain-access-card`,
				{ credential_name: 'Stripe' },
				H(s.ws.id),
			),
		)
		expect(res.status).toBe(409)
	})

	it('is refused for an agent that does not own the session', async () => {
		const s = await setup()
		await s.key('Stripe')
		expect((await post(s, { credential_name: 'Stripe' }, s.other.id)).status).toBe(403)
	})
})

describe('POST /integrations/:id/allow-from-chat (Integration)', () => {
	const allow = (
		s: Awaited<ReturnType<typeof setup>>,
		integrationId: string,
		body: unknown = { sessionId: s.session.id },
		as: { id: string; type: 'human' | 'agent' } = { id: s.human, type: 'human' },
	) =>
		appFor(as.id, as.type).request(
			jsonRequest('POST', `/api/integrations/${integrationId}/allow-from-chat`, body, H(s.ws.id)),
		)

	it('grants the agent whose session asked, audits it, and restarts that session', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		stopSession.mockClear()
		findActive.mockResolvedValueOnce({ id: s.session.id, status: 'running' } as never)

		const res = await allow(s, stripe.id)

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ actorId: s.agent.id })
		expect(await grantedActorIds(db, stripe.id)).toEqual([s.agent.id])
		// Only the agent that asked, never anyone else in the workspace.
		expect(await grantedActorIds(db, stripe.id)).not.toContain(s.other.id)
		expect(stopSession).toHaveBeenCalledWith(s.session.id)

		const ev = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, stripe.id), eq(events.action, 'updated')))
		expect(ev.some((e) => (e.data as { via?: string }).via === 'chat_card')).toBe(true)
	})

	it('Allow in this chat grants for that one conversation only, never as a permanent grant', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		const res = await allow(s, stripe.id, { sessionId: s.session.id, scope: 'chat' })
		expect(res.status).toBe(200)

		expect(await grantedActorIds(db, stripe.id)).toEqual([])
		const { agentChatGrants } = await import('@maskin/db/schema')
		const rows = await db
			.select()
			.from(agentChatGrants)
			.where(eq(agentChatGrants.integrationId, stripe.id))
		expect(rows.map((r) => [r.actorId, r.conversationId])).toEqual([
			[s.agent.id, s.conversation.id],
		])
		// The agent has it in this chat (so a second card finds it already granted)...
		const again = await appFor(s.agent.id, 'agent').request(
			jsonRequest(
				'POST',
				`/api/sessions/${s.session.id}/keychain-access-card`,
				{ credential_name: 'Stripe' },
				H(s.ws.id),
			),
		)
		expect(await again.json()).toMatchObject({ posted: false, already_granted: true })
		const ev = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, stripe.id), eq(events.action, 'updated')))
		expect(ev.some((e) => (e.data as { scope?: string }).scope === 'chat')).toBe(true)
	})

	it('Allow in this chat is refused for a session that is not in a chat', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		const autonomous = await insertSession(db, s.ws.id, s.agent.id, s.human, { status: 'running' })
		const res = await allow(s, stripe.id, { sessionId: autonomous.id, scope: 'chat' })
		expect(res.status).toBe(400)
	})

	it('grants read & write, since a saved key is on or off', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		await allow(s, stripe.id)
		const { agentGrants } = await import('@maskin/db/schema')
		const [g] = await db.select().from(agentGrants).where(eq(agentGrants.integrationId, stripe.id))
		expect(g.access).toBe('read_write')
	})

	it('is refused for an agent caller, and for a member who did not save it', async () => {
		const s = await setup()
		const stripe = await s.key('Stripe')
		expect((await allow(s, stripe.id, undefined, { id: s.agent.id, type: 'agent' })).status).toBe(
			403,
		)
		const stranger = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: stranger.id, role: 'member' })
		expect((await allow(s, stripe.id, undefined, { id: stranger.id, type: 'human' })).status).toBe(
			403,
		)
		expect(await grantedActorIds(db, stripe.id)).toEqual([])
	})

	it('only shares a saved key or login, and only for a session in this workspace', async () => {
		const s = await setup()
		const slack = (
			await db
				.insert(integrations)
				.values({
					workspaceId: s.ws.id,
					provider: 'slack',
					status: 'active',
					credentials: 'x',
					createdBy: s.human,
				})
				.returning()
		)[0]
		expect((await allow(s, slack.id)).status).toBe(400)

		const stripe = await s.key('Stripe')
		const elsewhere = await setup()
		expect((await allow(s, stripe.id, { sessionId: elsewhere.session.id })).status).toBe(404)
		expect(await grantedActorIds(db, stripe.id)).toEqual([])
	})
})
