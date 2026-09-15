import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// One comment must never queue two sessions for the same agent.
//
// Two independent code paths dispatch off a single `commented` event:
//
//   • `CommentDispatcher` (`services/trigger-runner.ts`), a PG NOTIFY
//     subscriber, which runs the case-2/case-3 fallback ladder and spawns a
//     `comment_fallback` session for the object's driver.
//   • `spawnThreadReplySessions` (`routes/events.ts`), called inline by the
//     create-comment handler, which spawns a `thread_reply` session for every
//     agent that previously participated in the thread.
//
// The thread-reply path deduped only against the @-MENTION branch of the
// dispatcher — and the fallback ladder only runs when a comment has NO
// mentions, which is exactly when that exclusion set is empty. So a reply with
// no mentions, on an object whose driver had already posted in the thread,
// reliably produced TWO sessions for one comment and one agent, doubling queue
// depth workspace-wide (insight 8515a7d8, 2026-09-15).
//
// This must be an integration test: the bug lives in the interaction between a
// route handler and a NOTIFY subscriber reading the same committed rows, and
// both paths resolve the driver by joining `objects` against real Postgres.
// A mocked-DB test enumerates `db.select()` calls positionally and can show
// that a query was added, never that the two dispatchers agree.

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

const { default: eventsRoutes } = await import('../../routes/events')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: unknown
	}
}

/**
 * ONE session-manager spy shared by both dispatch paths, so the assertion can
 * be "how many sessions did this comment produce in total" rather than a
 * per-path count that misses the double-dispatch by construction.
 */
function createSharedSessionManager() {
	return {
		enqueueSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		createSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		stopSession: vi.fn(),
		pauseSession: vi.fn(),
		resumeSession: vi.fn(),
		writeInput: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

type SharedSessionManager = ReturnType<typeof createSharedSessionManager>

function dispatchCalls(sm: SharedSessionManager) {
	return [
		...(sm.enqueueSession.mock.calls as unknown[][]),
		...(sm.createSession.mock.calls as unknown[][]),
	].map((call) => {
		const [first, second] = call
		return (second ?? first) as Record<string, unknown> & {
			actorId?: string
			triggerSource?: string
			config?: Record<string, unknown>
		}
	})
}

function createEventsApp(sessionManager: SharedSessionManager, actorId: string) {
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
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', sessionManager)
		await next()
	})

	app.route('/api/events', eventsRoutes)
	return app
}

/** The thread-reply spawn is fire-and-forget; let its promise chain settle. */
async function flushAsync() {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

function buildPgEvent(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	eventId: number
}): PgEvent {
	return {
		workspace_id: opts.workspaceId,
		actor_id: opts.actorId,
		action: 'commented',
		entity_type: 'object',
		entity_id: opts.entityId,
		event_id: String(opts.eventId),
	} as PgEvent
}

describe('one comment, one session per agent (comment_fallback vs thread_reply)', () => {
	let bridge: EventEmitter
	let sessionManager: SharedSessionManager
	let dispatcher: CommentDispatcher

	beforeEach(() => {
		capturePosthogEvent.mockClear()
		bridge = new EventEmitter()
		sessionManager = createSharedSessionManager()
		dispatcher = new CommentDispatcher(
			db,
			bridge as unknown as PgNotifyBridge,
			sessionManager as unknown as SessionManager,
		)
		dispatcher.start()
	})

	afterEach(() => {
		dispatcher.stop()
		vi.restoreAllMocks()
	})

	it('dispatches the driver once when it is also a prior thread participant', async () => {
		const humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		const driverAgent = await insertActor(db, { type: 'agent', name: 'Driver Agent' })
		const object = await insertObject(db, ws.id, humanId, { driver: driverAgent.id })

		// Thread so far: the human opened it, the driver agent replied. The
		// driver is therefore a thread participant, but NOT the author of the
		// comment being replied to — the one shape where case 2's own
		// loop-safety guard (driver !== parentAuthor) does not fire.
		const [root] = await db
			.insert(events)
			.values({
				workspaceId: ws.id,
				actorId: humanId,
				action: 'commented',
				entityType: 'object',
				entityId: object.id,
				data: { content: 'Opening question', mentions: [] },
			})
			.returning({ id: events.id })

		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: driverAgent.id,
			action: 'commented',
			entityType: 'object',
			entityId: object.id,
			data: { content: 'Agent reply', mentions: [], parentEventId: root.id },
		})

		const app = createEventsApp(sessionManager, humanId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: object.id, content: 'Following up', parent_event_id: root.id },
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(res.status).toBe(201)
		await flushAsync()

		// Now run the NOTIFY subscriber over the comment the route just wrote,
		// exactly as production does once the transaction commits.
		const [posted] = await db
			.select({ id: events.id })
			.from(events)
			.where(eq(events.entityId, object.id))
			.orderBy(desc(events.id))
			.limit(1)
		bridge.emit(
			'event',
			buildPgEvent({
				workspaceId: ws.id,
				actorId: humanId,
				entityId: object.id,
				eventId: posted.id,
			}),
		)
		await flushAsync()

		// Before the fix this was 2: a comment_fallback from the dispatcher AND
		// a thread_reply from the route, both for `driverAgent`.
		const calls = dispatchCalls(sessionManager)
		expect(calls).toHaveLength(1)
		expect(calls[0].actorId).toBe(driverAgent.id)
		expect(calls[0].triggerSource).toBe('comment_fallback')
		expect(calls[0].config?.thread_reply).toBeUndefined()
	})

	it('still spawns a thread reply for a participant who is not the fallback responder', async () => {
		const humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		const driverAgent = await insertActor(db, { type: 'agent', name: 'Driver Agent' })
		const otherAgent = await insertActor(db, { type: 'agent', name: 'Other Agent' })
		const object = await insertObject(db, ws.id, humanId, { driver: driverAgent.id })

		const [root] = await db
			.insert(events)
			.values({
				workspaceId: ws.id,
				actorId: humanId,
				action: 'commented',
				entityType: 'object',
				entityId: object.id,
				data: { content: 'Opening question', mentions: [] },
			})
			.returning({ id: events.id })

		// A non-driver agent participated in the thread. The exclusion is
		// scoped to the fallback responder alone, so this agent must still get
		// its thread-reply session — the fix must not silence the whole path.
		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: otherAgent.id,
			action: 'commented',
			entityType: 'object',
			entityId: object.id,
			data: { content: 'Other agent reply', mentions: [], parentEventId: root.id },
		})

		const app = createEventsApp(sessionManager, humanId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: object.id, content: 'Following up', parent_event_id: root.id },
				{ 'x-workspace-id': ws.id },
			),
		)
		expect(res.status).toBe(201)
		await flushAsync()

		const calls = dispatchCalls(sessionManager)
		expect(calls).toHaveLength(1)
		expect(calls[0].actorId).toBe(otherAgent.id)
		expect(calls[0].config?.thread_reply).toBeDefined()
	})
})
