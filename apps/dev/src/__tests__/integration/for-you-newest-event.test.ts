import { events } from '@maskin/db/schema'
import { and, eq, inArray, max } from 'drizzle-orm'
import { findNewestEventIds } from '../../lib/for-you-visibility'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId, sql as pg } from './global-setup'

/** The query findNewestEventIds replaced, kept here as the oracle. */
async function oldNewestEventIds(workspaceId: string, entityIds: string[]) {
	const rows = await db
		.select({ entityId: events.entityId, id: max(events.id) })
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), inArray(events.entityId, entityIds)))
		.groupBy(events.entityId)
	return new Map(rows.map((r) => [r.entityId, Number(r.id ?? 0)]))
}

describe('findNewestEventIds', () => {
	let workspaceId: string
	let otherWorkspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
		otherWorkspaceId = (await insertWorkspace(db, actorId)).id
	})

	const addEvent = async (wsId: string, entityId: string, action = 'commented') => {
		const [row] = await db
			.insert(events)
			.values({ workspaceId: wsId, actorId, action, entityType: 'object', entityId })
			.returning({ id: events.id })
		return Number(row.id)
	}

	it('returns the same newest event ids as max(id) GROUP BY entity_id', async () => {
		const a = await insertObject(db, workspaceId, actorId)
		const b = await insertObject(db, workspaceId, actorId)
		const quiet = await insertObject(db, workspaceId, actorId)
		await addEvent(workspaceId, a.id)
		await addEvent(workspaceId, b.id)
		await addEvent(workspaceId, a.id)
		const newestA = await addEvent(workspaceId, a.id)
		const newestB = await addEvent(workspaceId, b.id, 'updated')
		// An event in another workspace on the same entity must not count.
		await addEvent(otherWorkspaceId, a.id)

		const ids = [a.id, b.id, quiet.id, a.id]
		const next = await findNewestEventIds(db, workspaceId, ids)
		const old = await oldNewestEventIds(workspaceId, ids)

		expect(next).toEqual(old)
		expect(next.get(a.id)).toBe(newestA)
		expect(next.get(b.id)).toBe(newestB)
		expect(next.has(quiet.id)).toBe(false)
	})

	it('returns an empty map for no entities', async () => {
		expect((await findNewestEventIds(db, workspaceId, [])).size).toBe(0)
	})

	it('probes events_ws_entity_id_idx once per entity', async () => {
		const o = await insertObject(db, workspaceId, actorId)
		await addEvent(workspaceId, o.id)
		const plan = await pg.begin(async (tx) => {
			await tx`SET LOCAL enable_seqscan = off`
			return tx`EXPLAIN SELECT id FROM events WHERE workspace_id = ${workspaceId} AND entity_id = ${o.id} ORDER BY id DESC LIMIT 1`
		})
		expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('events_ws_entity_id_idx')
	})
})
