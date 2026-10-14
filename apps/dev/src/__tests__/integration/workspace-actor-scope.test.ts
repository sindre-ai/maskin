import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	files,
	notifications,
	sessions,
	subscriptions,
	triggers,
	workspaceMembers,
} from '@maskin/db/schema'
import { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSessionLifecycle, startSession } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import {
	buildCreateNotificationBody,
	buildCreateSessionBody,
	buildCreateTriggerBody,
	buildFile,
	insertActor,
	insertConversation,
	insertNotification,
	insertObject,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: notificationsRoutes } = await import('../../routes/notifications')
const { default: triggersRoutes } = await import('../../routes/triggers')
const { default: miniAppRegenRoutes } = await import('../../routes/mini-app-regen')
const { default: eventsRoutes } = await import('../../routes/events')

/**
 * Ids in a request body must belong to the caller's workspace before a session,
 * trigger or notification uses them. Against real Postgres because each case is
 * a membership or workspace_id lookup plus a "nothing was written" check, and
 * a mocked db can only assert against itself.
 *
 * The caller owns two workspaces (A, the request's, and B), so the only thing
 * standing between a request for A and B's rows is the guard under test. The
 * foreign agent is a member of B only.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

type Foreign = { conversation: string; object: string; trigger: string; session: string }

/** Body fragments that each point a new session at something in another workspace. */
function foreignSessionRefs(f: Foreign): Record<string, Record<string, unknown>> {
	return {
		'a conversation': {
			config: { conversation: { conversation_id: f.conversation, message_id: 1 } },
		},
		'a trigger': { trigger_id: f.trigger },
		'an originating object': { initiated_from_object_id: f.object },
		'a parent session': { source_session_id: f.session },
		'a dependency session': { depends_on_session_ids: [f.session] },
	}
}

/** Body fragments that each point a new notification at something in another workspace. */
function foreignNotificationRefs(f: Foreign, foreignAgent: string): Record<string, unknown> {
	return {
		'source actor': { source_actor_id: foreignAgent },
		'target actor': { target_actor_id: foreignAgent },
		object: { object_id: f.object },
		session: { session_id: f.session },
	}
}

function makeSessionManager() {
	return {
		createSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		resumeSession: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

type MockSessionManager = ReturnType<typeof makeSessionManager>

function createApp(sessionManager: MockSessionManager) {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', sessionManager as unknown as SessionManager)
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	app.route('/api/notifications', notificationsRoutes)
	app.route('/api/triggers', triggersRoutes)
	app.route('/api/mini-apps', miniAppRegenRoutes)
	app.route('/api/events', eventsRoutes)
	return app
}

describe('Actor and id scoping across workspaces', () => {
	let humanId: string
	let wsA: string
	let wsB: string
	let memberAgent: string
	let foreignAgent: string
	let foreign: Foreign
	let sessionManager: MockSessionManager
	let app: ReturnType<typeof createApp>

	beforeEach(async () => {
		humanId = getTestActorId()
		const a = await insertWorkspace(db, humanId)
		const b = await insertWorkspace(db, humanId)
		wsA = a.id
		wsB = b.id

		const member = await insertActor(db, { type: 'agent', name: 'Member Agent' })
		memberAgent = member.id
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: wsA, actorId: memberAgent, role: 'member' })

		const outsider = await insertActor(db, { type: 'agent', name: 'Foreign Agent' })
		foreignAgent = outsider.id
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: wsB, actorId: foreignAgent, role: 'member' })

		const conversation = await insertConversation(db, wsB, humanId)
		const object = await insertObject(db, wsB, humanId)
		const trigger = await insertTrigger(db, wsB, humanId, foreignAgent)
		const session = await insertSession(db, wsB, foreignAgent, humanId, { status: 'paused' })
		foreign = {
			conversation: conversation.id,
			object: object.id,
			trigger: trigger.id,
			session: session.id,
		}

		sessionManager = makeSessionManager()
		configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
		app = createApp(sessionManager)
	})

	async function sessionRows(workspaceId: string, actorId: string) {
		return db
			.select()
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.actorId, actorId)))
	}

	describe('startSession', () => {
		it.each(['rest', 'trigger', 'internal'] as const)(
			'refuses an agent from another workspace for a %s caller',
			async (callerKind) => {
				await expect(
					startSession({
						workspaceId: wsA,
						actorId: foreignAgent,
						callerKind,
						actionPrompt: 'Do the thing',
						initiatedFromObjectId: null,
					}),
				).rejects.toMatchObject({ status: 404 })

				expect(sessionManager.createSession).not.toHaveBeenCalled()
			},
		)

		it('starts a session for a member agent', async () => {
			await startSession({
				workspaceId: wsA,
				actorId: memberAgent,
				callerKind: 'internal',
				actionPrompt: 'Do the thing',
				initiatedFromObjectId: null,
			})

			expect(sessionManager.createSession).toHaveBeenCalledOnce()
		})
	})

	describe('POST /api/sessions', () => {
		function create(body: Record<string, unknown>) {
			return app.request(jsonRequest('POST', '/api/sessions', body, { 'x-workspace-id': wsA }))
		}

		it('returns 404 and creates no session for an agent from another workspace', async () => {
			const res = await create(buildCreateSessionBody({ actor_id: foreignAgent }))

			expect(res.status).toBe(404)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(await sessionRows(wsA, foreignAgent)).toHaveLength(0)
		})

		it.each([
			'a conversation',
			'a trigger',
			'an originating object',
			'a parent session',
			'a dependency session',
		])('returns 404 and creates no session for %s from another workspace', async (label) => {
			const extra = foreignSessionRefs(foreign)[label]
			const res = await create(buildCreateSessionBody({ actor_id: memberAgent, ...extra }))

			expect(res.status).toBe(404)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(await sessionRows(wsA, memberAgent)).toHaveLength(0)
		})

		it('still creates a session for a member agent', async () => {
			const row = await insertSession(db, wsA, memberAgent, humanId)
			sessionManager.createSession.mockResolvedValueOnce(row)

			const res = await create(buildCreateSessionBody({ actor_id: memberAgent }))

			expect(res.status).toBe(201)
			expect(sessionManager.createSession).toHaveBeenCalledOnce()
		})
	})

	describe('notifications', () => {
		function create(body: Record<string, unknown>) {
			return app.request(jsonRequest('POST', '/api/notifications', body, { 'x-workspace-id': wsA }))
		}

		async function notificationsInA() {
			return db.select().from(notifications).where(eq(notifications.workspaceId, wsA))
		}

		it.each(['source actor', 'target actor', 'object', 'session'])(
			'create returns 404 and writes nothing for a %s from another workspace',
			async (label) => {
				const extra = foreignNotificationRefs(foreign, foreignAgent)[label]
				const res = await create(
					buildCreateNotificationBody({ source_actor_id: memberAgent, ...(extra as object) }),
				)

				expect(res.status).toBe(404)
				expect(await notificationsInA()).toHaveLength(0)
			},
		)

		it('create still works for ids inside the workspace', async () => {
			const res = await create(
				buildCreateNotificationBody({ source_actor_id: memberAgent, target_actor_id: humanId }),
			)

			expect(res.status).toBe(201)
		})

		it('respond returns 404 and leaves the notification pending when the header names another workspace', async () => {
			// The caller is a member of both workspaces; only the workspace match stops this.
			const inB = await insertNotification(db, wsB, foreignAgent, { status: 'pending' })

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${inB.id}/respond`,
					{ response: 'Approved' },
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const [after] = await db.select().from(notifications).where(eq(notifications.id, inB.id))
			expect(after?.status).toBe('pending')
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('respond does not resume a session that lives in another workspace', async () => {
			// Seeded straight into the table: the create route would refuse this link.
			const linked = await insertNotification(db, wsA, memberAgent, {
				status: 'pending',
				sessionId: foreign.session,
			})

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${linked.id}/respond`,
					{ response: 'Approved' },
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(200)
			// The wake-up is fire-and-forget; give it time to run.
			await vi.waitFor(() => expect(sessionManager.createSession).toHaveBeenCalledOnce())
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
			const [, params] = sessionManager.createSession.mock.calls[0] as [string, { actorId: string }]
			expect(params.actorId).toBe(memberAgent)
		})
	})

	describe('triggers', () => {
		it('create returns 404 and writes nothing for an agent from another workspace', async () => {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({ target_actor_id: foreignAgent }),
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const rows = await db.select().from(triggers).where(eq(triggers.workspaceId, wsA))
			expect(rows).toHaveLength(0)
		})

		it('create still works for a member agent', async () => {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/triggers',
					buildCreateTriggerBody({ target_actor_id: memberAgent }),
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(201)
		})

		it('update returns 404 and keeps the target when the new agent is from another workspace', async () => {
			const own = await insertTrigger(db, wsA, humanId, memberAgent)

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/triggers/${own.id}`,
					{ target_actor_id: foreignAgent },
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const [after] = await db.select().from(triggers).where(eq(triggers.id, own.id))
			expect(after?.targetActorId).toBe(memberAgent)
		})
	})

	describe('POST /api/mini-apps/regen', () => {
		it('returns 404 and provisions nothing for an agent from another workspace', async () => {
			const file = buildFile({
				workspaceId: wsA,
				name: 'app.html',
				mimeType: 'text/html',
				createdBy: humanId,
			})
			await db.insert(files).values(file)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/mini-apps/regen',
					{ file_id: file.id, target_actor_id: foreignAgent },
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const rows = await db.select().from(triggers).where(eq(triggers.workspaceId, wsA))
			expect(rows).toHaveLength(0)
		})
	})

	describe('comment mentions', () => {
		let bridge: PgNotifyBridge
		let dispatcher: CommentDispatcher

		beforeEach(async () => {
			const url = process.env.DATABASE_URL
			if (!url) throw new Error('DATABASE_URL required for integration tests')
			bridge = new PgNotifyBridge(url)
			await bridge.start()
			dispatcher = new CommentDispatcher(db, bridge, sessionManager as unknown as SessionManager)
			dispatcher.start()
		})

		afterEach(async () => {
			dispatcher.stop()
			await bridge.stop()
		})

		it('starts no session and subscribes nobody for an agent from another workspace', async () => {
			const object = await insertObject(db, wsA, humanId)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{
						entity_id: object.id,
						content: 'Both of you, please look',
						// The member agent is the control: its session proves the dispatcher ran.
						mentions: [memberAgent, foreignAgent],
					},
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(201)
			const body = (await res.json()) as { unresolved_mentions?: string[] }
			expect(body.unresolved_mentions).toEqual([foreignAgent])

			await vi.waitFor(() => expect(sessionManager.createSession).toHaveBeenCalled(), {
				timeout: 10_000,
				interval: 25,
			})
			const actorsStarted = sessionManager.createSession.mock.calls.map(
				(c) => (c[1] as { actorId: string }).actorId,
			)
			expect(actorsStarted).toEqual([memberAgent])

			const foreignNotifications = await db
				.select()
				.from(notifications)
				.where(eq(notifications.targetActorId, foreignAgent))
			expect(foreignNotifications).toHaveLength(0)
			const foreignSubscriptions = await db
				.select()
				.from(subscriptions)
				.where(and(eq(subscriptions.actorId, foreignAgent), eq(subscriptions.entityId, object.id)))
			expect(foreignSubscriptions).toHaveLength(0)
		})
	})
})
