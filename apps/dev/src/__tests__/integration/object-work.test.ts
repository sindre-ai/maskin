import { events, objects } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import {
	AGENT_FINISHED_WORKING,
	AGENT_STARTED_WORKING,
	startWorkingOnObject,
	stopWorkingOnObjects,
} from '../../services/object-work'
import { insertObject, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The active_session_id pointer and its permanent Activity rows, against real
// Postgres: the conditional UPDATE ... RETURNING decides whether an event is
// written, so a mocked db cannot show that a repeat call stays silent.
describe('object work bookkeeping', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	async function workEvents(objectId: string) {
		return db
			.select()
			.from(events)
			.where(and(eq(events.entityId, objectId), eq(events.entityType, 'object')))
			.orderBy(desc(events.id))
	}

	async function pointerOf(objectId: string) {
		const [row] = await db.select().from(objects).where(eq(objects.id, objectId)).limit(1)
		return row?.activeSessionId ?? null
	}

	it('points the object at the session and records one started event', async () => {
		const object = await insertObject(db, workspaceId, actorId, { type: 'task' })
		const session = await insertSession(db, workspaceId, actorId, actorId)

		const linked = await startWorkingOnObject(db, {
			workspaceId,
			objectId: object.id,
			sessionId: session.id,
			actorId,
		})

		expect(linked).toBe(true)
		expect(await pointerOf(object.id)).toBe(session.id)
		const rows = await workEvents(object.id)
		expect(rows.map((r) => r.action)).toEqual([AGENT_STARTED_WORKING])
		expect(rows[0]?.data).toEqual({ session_id: session.id })
	})

	it('records nothing when the same session claims the object again', async () => {
		const object = await insertObject(db, workspaceId, actorId, { type: 'task' })
		const session = await insertSession(db, workspaceId, actorId, actorId)
		const claim = { workspaceId, objectId: object.id, sessionId: session.id, actorId }

		await startWorkingOnObject(db, claim)
		const again = await startWorkingOnObject(db, claim)

		expect(again).toBe(false)
		expect(await workEvents(object.id)).toHaveLength(1)
	})

	it('does not touch an object that belongs to another workspace', async () => {
		const otherWorkspaceId = (await insertWorkspace(db, actorId)).id
		const object = await insertObject(db, otherWorkspaceId, actorId, { type: 'task' })
		const session = await insertSession(db, workspaceId, actorId, actorId)

		const linked = await startWorkingOnObject(db, {
			workspaceId,
			objectId: object.id,
			sessionId: session.id,
			actorId,
		})

		expect(linked).toBe(false)
		expect(await pointerOf(object.id)).toBeNull()
		expect(await workEvents(object.id)).toHaveLength(0)
	})

	it('clears the pointer once and records a finished event', async () => {
		const object = await insertObject(db, workspaceId, actorId, { type: 'bet' })
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await startWorkingOnObject(db, {
			workspaceId,
			objectId: object.id,
			sessionId: session.id,
			actorId,
		})

		await stopWorkingOnObjects(db, { sessionId: session.id })
		await stopWorkingOnObjects(db, { sessionId: session.id })

		expect(await pointerOf(object.id)).toBeNull()
		const actions = (await workEvents(object.id)).map((r) => r.action).reverse()
		expect(actions).toEqual([AGENT_STARTED_WORKING, AGENT_FINISHED_WORKING])
	})

	it('leaves an object that a newer session has taken over', async () => {
		const object = await insertObject(db, workspaceId, actorId, { type: 'task' })
		const first = await insertSession(db, workspaceId, actorId, actorId)
		const second = await insertSession(db, workspaceId, actorId, actorId)
		const claim = { workspaceId, objectId: object.id, actorId }
		await startWorkingOnObject(db, { ...claim, sessionId: first.id })
		await startWorkingOnObject(db, { ...claim, sessionId: second.id })

		await stopWorkingOnObjects(db, { sessionId: first.id })

		expect(await pointerOf(object.id)).toBe(second.id)
	})
})
