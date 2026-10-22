import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordEvent } from '../../lib/events/record-event'
import { MENTION_GUARD_LIMITS } from '../../services/mention-guards'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import {
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// POST /api/sessions links a new session to the one that started it
// (sessions.spawned_by_session_id) only when the X-Maskin-Session-Id claim is the
// authenticated caller's own live session. Real Postgres and the real
// SessionManager.createSession, so the column write is covered too.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: sessionsRoutes } = await import('../../routes/sessions')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; maskinSessionId?: string }
}

describe('POST /api/sessions: authenticated spawn link (integration)', () => {
	let manager: SessionManager
	let app: OpenAPIHono<Env>
	let workspaceId: string
	let otherWorkspaceId: string
	let caller: { id: string }
	let stranger: { id: string }
	let target: { id: string }

	// global-setup truncates between tests, so rows are created per test and the
	// app (built once) reads them through these variables.
	beforeEach(async () => {
		const human = getTestActorId()
		workspaceId = (await insertWorkspace(db, human, { enterpriseGranted: true })).id
		otherWorkspaceId = (await insertWorkspace(db, human, { enterpriseGranted: true })).id
		const mk = (name: string) =>
			insertActor(db, {
				type: 'agent',
				name,
				email: `${name}-${Math.random().toString(36).slice(2)}@integration.test`,
				apiKey: `ank_${name}_${Math.random().toString(36).slice(2)}`,
			})
		;[caller, stranger, target] = await Promise.all([mk('Caller'), mk('Stranger'), mk('Target')])
		// Starting a session needs the agent to belong to the workspace.
		for (const agent of [caller, stranger, target]) {
			await ensureWorkspaceMember(db, workspaceId, agent.id)
		}
	})

	beforeAll(() => {
		manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		app = new OpenAPIHono<Env>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			// The test stands in for authMiddleware: the authenticated actor is named in a header.
			c.set('actorId', c.req.header('X-Test-Actor-Id') ?? caller.id)
			c.set('actorType', 'agent')
			// Same shape check app-factory.ts applies to X-Maskin-Session-Id.
			const raw = c.req.header('X-Maskin-Session-Id')?.trim()
			if (raw && UUID_RE.test(raw)) c.set('maskinSessionId', raw)
			await next()
		})
		app.route('/api/sessions', sessionsRoutes as never)
	})

	afterAll(async () => {
		await manager.stop()
	})

	async function spawn(claimed: string | null, extra?: Record<string, unknown>) {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/sessions',
				{ actor_id: target.id, action_prompt: 'help me', auto_start: false, ...extra },
				{
					'X-Workspace-Id': workspaceId,
					'X-Test-Actor-Id': caller.id,
					...(claimed ? { 'X-Maskin-Session-Id': claimed } : {}),
				},
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { id: string; spawnLinkDropped?: string }
		const [row] = await db.select().from(sessions).where(eq(sessions.id, body.id))
		return { body, row }
	}

	const liveSessionOf = (actorId: string, over?: Record<string, unknown>) =>
		insertSession(db, workspaceId, actorId, actorId, { status: 'running', ...over })

	it('links the helper to the caller’s own live session and records depth 1', async () => {
		const mine = await liveSessionOf(caller.id)
		const { row } = await spawn(mine.id)
		expect(row.spawnedBySessionId).toBe(mine.id)
		expect(row.sourceSessionId).toBeNull()
		expect((row.config as { hop_depth?: number }).hop_depth).toBe(1)
	})

	it('leaves the link null when there is no header', async () => {
		const { row } = await spawn(null)
		expect(row.spawnedBySessionId).toBeNull()
		expect((row.config as { hop_depth?: number }).hop_depth).toBeUndefined()
	})

	it('forged header: another actor’s live session is not linked', async () => {
		const theirs = await liveSessionOf(stranger.id)
		const { row } = await spawn(theirs.id)
		expect(row.spawnedBySessionId).toBeNull()
	})

	it('a terminal session of the caller is not linked', async () => {
		for (const status of ['completed', 'failed', 'timeout', 'user_stopped']) {
			const done = await liveSessionOf(caller.id, { status })
			const { row } = await spawn(done.id)
			expect(row.spawnedBySessionId, status).toBeNull()
		}
	})

	it('a session from another workspace is not linked', async () => {
		const elsewhere = await insertSession(db, otherWorkspaceId, caller.id, caller.id, {
			status: 'running',
		})
		const { row } = await spawn(elsewhere.id)
		expect(row.spawnedBySessionId).toBeNull()
	})

	it('an unknown session id is not linked, and the work still runs', async () => {
		const { row } = await spawn('11111111-2222-4333-8444-555555555555')
		expect(row.spawnedBySessionId).toBeNull()
		expect(row.status).toBe('pending')
	})

	it('depth grows by one per hop and the chain stops linking above the cap', async () => {
		let sender = await liveSessionOf(caller.id)
		for (let depth = 1; depth <= MENTION_GUARD_LIMITS.maxHopDepth; depth++) {
			const { row } = await spawn(sender.id)
			expect(row.spawnedBySessionId).toBe(sender.id)
			expect((row.config as { hop_depth?: number }).hop_depth).toBe(depth)
			// The helper becomes the next sender: same actor as the caller so the
			// ownership check passes, still running.
			sender = await liveSessionOf(caller.id, { config: row.config })
		}
		const { body, row } = await spawn(sender.id)
		expect(row.spawnedBySessionId).toBeNull()
		expect(body.spawnLinkDropped).toBe('hop_cap')
		expect(row.status).toBe('pending')
	})

	describe('notify_on_complete', () => {
		const flagOf = (row: { config: unknown }) =>
			(row.config as { notify_on_complete?: boolean }).notify_on_complete

		it('is stored on the helper when the link is accepted', async () => {
			const mine = await liveSessionOf(caller.id)
			const { row } = await spawn(mine.id, { notify_on_complete: true })
			expect(row.spawnedBySessionId).toBe(mine.id)
			expect(flagOf(row)).toBe(true)
		})

		it('is not stored when the flag is omitted or false', async () => {
			const mine = await liveSessionOf(caller.id)
			expect(flagOf((await spawn(mine.id)).row)).toBeUndefined()
			expect(flagOf((await spawn(mine.id, { notify_on_complete: false })).row)).toBeUndefined()
		})

		it('is dropped when there is no link to return through', async () => {
			expect(flagOf((await spawn(null, { notify_on_complete: true })).row)).toBeUndefined()
			const theirs = await liveSessionOf(stranger.id)
			expect(flagOf((await spawn(theirs.id, { notify_on_complete: true })).row)).toBeUndefined()
		})

		describe('PATCH (create_session wait:true sets it when its wait times out)', () => {
			let objectId: string

			beforeEach(async () => {
				objectId = (await insertObject(db, workspaceId, getTestActorId(), { type: 'task' })).id
			})

			const patch = (id: string, body: unknown, actorId = caller.id) =>
				app.request(
					jsonRequest('PATCH', `/api/sessions/${id}`, body, {
						'X-Workspace-Id': workspaceId,
						'X-Test-Actor-Id': actorId,
					}),
				)

			const returnComments = () =>
				db
					.select()
					.from(events)
					.where(
						and(
							eq(events.entityId, objectId),
							eq(events.action, 'commented'),
							eq(events.actorId, target.id),
						),
					)

			const endedSender = () =>
				insertSession(db, workspaceId, caller.id, caller.id, {
					status: 'completed',
					initiatedFromObjectId: objectId,
				})

			const helperOf = (sender: { id: string }, over?: Record<string, unknown>) =>
				insertSession(db, workspaceId, target.id, caller.id, {
					status: 'running',
					spawnedBySessionId: sender.id,
					result: { exit_code: 0 },
					...over,
				})

			it('sets the flag for the actor who started the helper, and a running helper sends nothing yet', async () => {
				const sender = await liveSessionOf(caller.id)
				const helper = await helperOf(sender)
				const res = await patch(helper.id, { notify_on_complete: true })
				expect(res.status).toBe(200)
				const [row] = await db.select().from(sessions).where(eq(sessions.id, helper.id))
				expect(flagOf(row)).toBe(true)
				expect(row.helperReturnedAt).toBeNull()
				expect((await res.json()).notify_on_complete).toBe('registered')
			})

			it('refuses a helper with no spawn link with 400 and does not store the flag', async () => {
				const helper = await insertSession(db, workspaceId, target.id, caller.id, {
					status: 'running',
				})
				const res = await patch(helper.id, { notify_on_complete: true })
				expect(res.status).toBe(400)
				const [row] = await db.select().from(sessions).where(eq(sessions.id, helper.id))
				expect(flagOf(row)).toBeUndefined()
			})

			it('says skipped, with the reason, when an ended helper could not be returned', async () => {
				// No originating object and no chat: nowhere to land.
				const sender = await insertSession(db, workspaceId, caller.id, caller.id, {
					status: 'completed',
				})
				const helper = await helperOf(sender, { status: 'completed' })
				const res = await patch(helper.id, { notify_on_complete: true })
				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.notify_on_complete).toBe('skipped')
				expect(body.notify_skip_reason).toBe('no_destination')
			})

			it('refuses another actor with 403 and leaves the flag off', async () => {
				const sender = await liveSessionOf(caller.id)
				const helper = await helperOf(sender)
				const res = await patch(helper.id, { notify_on_complete: true }, stranger.id)
				expect(res.status).toBe(403)
				const [row] = await db.select().from(sessions).where(eq(sessions.id, helper.id))
				expect(flagOf(row)).toBeUndefined()
			})

			it('rejects a body with neither field', async () => {
				const sender = await liveSessionOf(caller.id)
				const helper = await helperOf(sender)
				expect((await patch(helper.id, {})).status).toBe(400)
			})

			it('a helper that already ended sends its return right away', async () => {
				const helper = await helperOf(await endedSender(), { status: 'completed' })
				const res = await patch(helper.id, { notify_on_complete: true })
				expect(res.status).toBe(200)
				expect((await res.json()).notify_on_complete).toBe('delivered')
				expect(await returnComments()).toHaveLength(1)
			})

			it('gives the claim back when the earlier return was skipped only because the sender was live', async () => {
				const helper = await helperOf(await endedSender(), {
					status: 'completed',
					helperReturnedAt: new Date(),
				})
				await recordEvent(db, {
					workspaceId,
					actorId: target.id,
					action: 'helper_return_skipped',
					entityType: 'session',
					entityId: helper.id,
					data: { reason: 'sender_live' },
				})
				expect((await patch(helper.id, { notify_on_complete: true })).status).toBe(200)
				expect(await returnComments()).toHaveLength(1)
			})

			it('does not send a second return when the helper was already returned', async () => {
				const helper = await helperOf(await endedSender(), {
					status: 'completed',
					helperReturnedAt: new Date(),
				})
				expect((await patch(helper.id, { notify_on_complete: true })).status).toBe(200)
				expect(await returnComments()).toHaveLength(0)
			})
		})
	})
})
