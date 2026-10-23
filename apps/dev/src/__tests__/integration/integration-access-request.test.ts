import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	agentGrants,
	conversations,
	integrations,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertAgentGrant, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: grantsRoutes } = await import('../../routes/integrations-grants')

/**
 * An agent asks for access to an integration that is connected but not allowed for it:
 * request_integration_access (a card) -> the person allows it (the agent's own grant, then a
 * restart). Against real Postgres: the grant, the audit row and the card are all writes.
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
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const [conversation] = await db
		.insert(conversations)
		.values({ workspaceId: ws.id, title: 'Chat', createdBy: human })
		.returning()
	const session = await insertSession(db, ws.id, agent.id, human, {
		interactive: true,
		conversationId: conversation.id,
		status: 'running',
	})
	const integration = async (over: Record<string, unknown> = {}) =>
		(
			await db
				.insert(integrations)
				.values({
					workspaceId: ws.id,
					provider: 'slack',
					status: 'active',
					credentials: 'x',
					defaultAgentAccess: 'none',
					createdBy: human,
					...over,
				})
				.returning()
		)[0]
	return { human, ws, agent, conversation, session, integration }
}
type Setup = Awaited<ReturnType<typeof setup>>

const H = (workspaceId: string) => ({ 'X-Workspace-Id': workspaceId })

const card = (s: Setup, body: unknown, sessionId = s.session.id, as = s.agent.id) =>
	appFor(as, 'agent').request(
		jsonRequest('POST', `/api/sessions/${sessionId}/integration-access-card`, body, H(s.ws.id)),
	)

const grantsOf = (integrationId: string) =>
	db.select().from(agentGrants).where(eq(agentGrants.integrationId, integrationId))

describe('POST /sessions/:id/integration-access-card (Integration)', () => {
	it('posts a card as the agent naming the integration and level, and changes no access', async () => {
		const s = await setup()
		const slack = await s.integration()

		const res = await card(s, {
			integration_id: slack.id,
			level: 'read_write',
			reason: 'To post the summary.',
		})

		expect(res.status).toBe(200)
		const out = (await res.json()) as {
			posted: boolean
			already_granted: boolean
			message_id: number
		}
		expect(out).toMatchObject({ posted: true, already_granted: false })
		const rows = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, s.conversation.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(s.agent.id)
		expect(rows[0]?.id).toBe(out.message_id)
		expect(
			(rows[0]?.metadata as { integration_access_request?: unknown }).integration_access_request,
		).toEqual({
			session_id: s.session.id,
			integration_id: slack.id,
			provider: 'slack',
			display_name: 'Slack',
			level: 'read_write',
			reason: 'To post the summary.',
		})
		// A card is a question: the agent's access is exactly what it was.
		expect(await grantsOf(slack.id)).toEqual([])
	})

	it('posts nothing when the agent already has that much, by default or by its own grant', async () => {
		const s = await setup()
		const byDefault = await s.integration({ defaultAgentAccess: 'read' })
		expect(
			await (await card(s, { integration_id: byDefault.id, level: 'read' })).json(),
		).toMatchObject({ posted: false, already_granted: true })
		const granted = await s.integration({ provider: 'linear' })
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: granted.id,
			actorId: s.agent.id,
			access: 'read_write',
		})
		expect(
			await (await card(s, { integration_id: granted.id, level: 'read' })).json(),
		).toMatchObject({
			posted: false,
			already_granted: true,
		})
		// Read is not enough for a request to write.
		expect(
			await (await card(s, { integration_id: byDefault.id, level: 'read_write' })).json(),
		).toMatchObject({ posted: true })
		const rows = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, s.conversation.id))
		expect(rows).toHaveLength(1)
	})

	it('sends a saved key to the keychain tools, and 404s an integration that is not connected here', async () => {
		const s = await setup()
		const key = await s.integration({
			provider: 'custom',
			providerMode: 'byo_apikey',
			displayName: 'Stripe',
		})
		expect((await card(s, { integration_id: key.id, level: 'read_write' })).status).toBe(400)

		const revoked = await s.integration({ provider: 'linear', status: 'revoked' })
		expect((await card(s, { integration_id: revoked.id, level: 'read' })).status).toBe(404)
		const elsewhere = await setup()
		const foreign = await elsewhere.integration()
		expect((await card(s, { integration_id: foreign.id, level: 'read' })).status).toBe(404)
		expect(
			(await db.select().from(messages).where(eq(messages.conversationId, s.conversation.id)))
				.length,
		).toBe(0)
	})

	it('rejects a level it does not know, and a session that is not the caller’s', async () => {
		const s = await setup()
		const slack = await s.integration()
		expect((await card(s, { integration_id: slack.id, level: 'none' })).status).toBe(400)
		const other = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: other.id, role: 'member' })
		expect(
			(await card(s, { integration_id: slack.id, level: 'read' }, s.session.id, other.id)).status,
		).toBe(403)
	})

	it('answers 409 for a run with no chat', async () => {
		const s = await setup()
		const slack = await s.integration()
		const autonomous = await insertSession(db, s.ws.id, s.agent.id, s.human, { status: 'running' })
		expect((await card(s, { integration_id: slack.id, level: 'read' }, autonomous.id)).status).toBe(
			409,
		)
	})

	it('for a helper: posts in the chat it was started from, flagged for the helper, and marks it waiting', async () => {
		const s = await setup()
		const slack = await s.integration()
		const helper = await insertSession(db, s.ws.id, s.agent.id, s.human, {
			interactive: true,
			conversationId: null,
			status: 'running',
			config: { stop_on_result: true, ask_conversation_id: s.conversation.id },
		})

		const res = await card(s, { integration_id: slack.id, level: 'read' }, helper.id)

		expect(res.status).toBe(200)
		const out = (await res.json()) as { message_id: number }
		const rows = await db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, s.conversation.id))
		expect(rows).toHaveLength(1)
		expect(
			(rows[0]?.metadata as { integration_access_request?: { reply_to_session?: boolean } })
				.integration_access_request?.reply_to_session,
		).toBe(true)
		const [row] = await db
			.select({ config: sessions.config })
			.from(sessions)
			.where(eq(sessions.id, helper.id))
		expect((row?.config as { awaiting?: { message_id: number } }).awaiting?.message_id).toBe(
			out.message_id,
		)
	})
})

describe('POST /integrations/:id/allow-access (Integration)', () => {
	const allow = (
		s: Setup,
		integrationId: string,
		body: unknown = { sessionId: s.session.id, level: 'read_write' },
		as: { id: string; type: 'human' | 'agent' } = { id: s.human, type: 'human' },
	) =>
		appFor(as.id, as.type).request(
			jsonRequest('POST', `/api/integrations/${integrationId}/allow-access`, body, H(s.ws.id)),
		)

	it('gives the agent whose session asked that level, audits it, and restarts that session', async () => {
		const s = await setup()
		const slack = await s.integration()
		stopSession.mockClear()
		findActive.mockResolvedValueOnce({ id: s.session.id, status: 'running' } as never)

		const res = await allow(s, slack.id)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ actorId: s.agent.id, changed: true, relaunch: 'stopped' })
		expect((await grantsOf(slack.id)).map((g) => [g.actorId, g.access])).toEqual([
			[s.agent.id, 'read_write'],
		])
		expect(stopSession).toHaveBeenCalledWith(s.session.id)
		const ev = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, slack.id), eq(events.action, 'updated')))
		expect(ev.map((e) => e.data)).toContainEqual(
			expect.objectContaining({
				change: 'agent_grant',
				provider: 'slack',
				agent_id: s.agent.id,
				access_before: null,
				access_after: 'read_write',
				via: 'chat_card',
			}),
		)
	})

	it('can give read only, and leaves every other agent as it was', async () => {
		const s = await setup()
		const slack = await s.integration()
		const other = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: other.id, role: 'member' })

		expect((await allow(s, slack.id, { sessionId: s.session.id, level: 'read' })).status).toBe(200)

		expect((await grantsOf(slack.id)).map((g) => [g.actorId, g.access])).toEqual([
			[s.agent.id, 'read'],
		])
	})

	it('never narrows: an agent that already has this much keeps its access and is not restarted', async () => {
		const s = await setup()
		const slack = await s.integration()
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: slack.id,
			actorId: s.agent.id,
			access: 'read_write',
		})
		stopSession.mockClear()

		const res = await allow(s, slack.id, { sessionId: s.session.id, level: 'read' })

		expect(await res.json()).toMatchObject({ changed: false })
		expect((await grantsOf(slack.id)).map((g) => g.access)).toEqual(['read_write'])
		expect(stopSession).not.toHaveBeenCalled()
	})

	it('is refused for an agent caller and for a member who did not connect it, and changes nothing', async () => {
		const s = await setup()
		const slack = await s.integration()
		expect((await allow(s, slack.id, undefined, { id: s.agent.id, type: 'agent' })).status).toBe(
			403,
		)
		const stranger = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: stranger.id, role: 'member' })
		expect((await allow(s, slack.id, undefined, { id: stranger.id, type: 'human' })).status).toBe(
			403,
		)
		expect(await grantsOf(slack.id)).toEqual([])
	})

	it('is for a connected integration with levels: not a saved key, not a revoked one, not another workspace’s session', async () => {
		const s = await setup()
		const key = await s.integration({
			provider: 'custom',
			providerMode: 'byo_apikey',
			displayName: 'Stripe',
		})
		expect((await allow(s, key.id)).status).toBe(400)
		const revoked = await s.integration({ provider: 'linear', status: 'revoked' })
		expect((await allow(s, revoked.id)).status).toBe(409)
		const slack = await s.integration({ provider: 'posthog' })
		const elsewhere = await setup()
		expect(
			(await allow(s, slack.id, { sessionId: elsewhere.session.id, level: 'read' })).status,
		).toBe(404)
		expect(await grantsOf(slack.id)).toEqual([])
		expect(await grantsOf(key.id)).toEqual([])
	})

	it('rejects a level it does not know', async () => {
		const s = await setup()
		const slack = await s.integration()
		expect((await allow(s, slack.id, { sessionId: s.session.id, level: 'admin' })).status).toBe(400)
		expect(await grantsOf(slack.id)).toEqual([])
	})
})
