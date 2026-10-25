import { EventEmitter } from 'node:events'
import { events, notifications } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { CommentDispatcher } from '../../services/trigger-runner'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// One comment event that mentions one agent must wake that agent once. During a
// rolling deploy the old and the new app instance each run a CommentDispatcher
// on the same NOTIFY, so the dispatch has to be claimed in the database: the
// mocked-db tests cannot show two writers racing for one row.

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

function createSessionManager() {
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

const sessionStarts = (sm: ReturnType<typeof createSessionManager>) =>
	sm.enqueueSession.mock.calls.length + sm.createSession.mock.calls.length

async function comment(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	mentions: string[]
}): Promise<number> {
	const [row] = await db
		.insert(events)
		.values({
			workspaceId: opts.workspaceId,
			actorId: opts.actorId,
			action: 'commented',
			entityType: 'object',
			entityId: opts.entityId,
			data: { content: 'please take a look', mentions: opts.mentions },
		})
		.returning({ id: events.id })
	return row.id
}

const pgEvent = (
	ws: { id: string },
	actorId: string,
	entityId: string,
	eventId: number,
): PgEvent => ({
	workspace_id: ws.id,
	actor_id: actorId,
	action: 'commented',
	entity_type: 'object',
	entity_id: entityId,
	event_id: String(eventId),
})

describe('Comment mention dispatch is idempotent per (comment event, mentioned actor)', () => {
	let sm: ReturnType<typeof createSessionManager>
	// Two bridges + two dispatchers stand in for the two app instances of a rolling deploy.
	let bridges: Array<EventEmitter & PgNotifyBridge>
	let dispatchers: CommentDispatcher[]

	beforeEach(() => {
		capturePosthogEvent.mockClear()
		sm = createSessionManager()
		configureSessionLifecycle({ db, sessionManager: sm as unknown as SessionManager })
		bridges = [0, 1].map(() => new EventEmitter() as EventEmitter & PgNotifyBridge)
		dispatchers = bridges.map((b) => new CommentDispatcher(db, b, sm as unknown as SessionManager))
		for (const d of dispatchers) d.start()
	})

	afterEach(() => {
		for (const d of dispatchers) d.stop()
		vi.restoreAllMocks()
	})

	async function world() {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Reviewer',
			email: `reviewer-${Math.random().toString(36).slice(2)}@integration.test`,
			apiKey: `ank_reviewer_${Math.random().toString(36).slice(2)}`,
		})
		await ensureWorkspaceMember(db, ws.id, agent.id)
		const object = await insertObject(db, ws.id, human, { type: 'task', title: 'review me' })
		return { human, ws, agent, object }
	}

	async function notificationsFor(agentId: string, objectId: string) {
		const rows = await db
			.select()
			.from(notifications)
			.where(eq(notifications.targetActorId, agentId))
		return rows.filter((n) => n.objectId === objectId)
	}

	const settle = () => new Promise((r) => setTimeout(r, 500))

	it('two app instances receiving the same event start one session and write one notification', async () => {
		const { human, ws, agent, object } = await world()
		const id = await comment({
			workspaceId: ws.id,
			actorId: human,
			entityId: object.id,
			mentions: [agent.id],
		})

		// Same NOTIFY payload reaches both instances at the same moment.
		for (const b of bridges) b.emit('event', pgEvent(ws, human, object.id, id))
		await settle()

		expect(sessionStarts(sm)).toBe(1)
		const rows = await notificationsFor(agent.id, object.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].metadata).toEqual({ comment_event_id: id })
	})

	it('firing the dispatch twice for the same comment event starts one session', async () => {
		const { human, ws, agent, object } = await world()
		const id = await comment({
			workspaceId: ws.id,
			actorId: human,
			entityId: object.id,
			mentions: [agent.id],
		})

		await Promise.all([
			dispatchers[0].handleEvent(pgEvent(ws, human, object.id, id)),
			dispatchers[0].handleEvent(pgEvent(ws, human, object.id, id)),
		])
		// And again after the first pair has finished: still a no-op.
		await dispatchers[1].handleEvent(pgEvent(ws, human, object.id, id))

		expect(sessionStarts(sm)).toBe(1)
		expect(await notificationsFor(agent.id, object.id)).toHaveLength(1)
	})

	it('separate comment events and separate objects still start separate sessions', async () => {
		const { human, ws, agent, object } = await world()
		const other = await insertObject(db, ws.id, human, { type: 'task', title: 'another' })

		const first = await comment({
			workspaceId: ws.id,
			actorId: human,
			entityId: object.id,
			mentions: [agent.id],
		})
		const second = await comment({
			workspaceId: ws.id,
			actorId: human,
			entityId: object.id,
			mentions: [agent.id],
		})
		const onOther = await comment({
			workspaceId: ws.id,
			actorId: human,
			entityId: other.id,
			mentions: [agent.id],
		})

		await dispatchers[0].handleEvent(pgEvent(ws, human, object.id, first))
		await dispatchers[1].handleEvent(pgEvent(ws, human, object.id, second))
		await dispatchers[0].handleEvent(pgEvent(ws, human, other.id, onOther))

		expect(sessionStarts(sm)).toBe(3)
		expect(await notificationsFor(agent.id, object.id)).toHaveLength(2)
		expect(await notificationsFor(agent.id, other.id)).toHaveLength(1)
	})
})
