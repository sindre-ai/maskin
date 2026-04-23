import type { Database } from '@maskin/db'
import { describe, expect, it } from 'vitest'
import { notifyParticipants } from '../../lib/notifications'

type MockRow = { sourceId: string; targetId: string; type: string }

/**
 * Minimal mock Database that returns the participant edges from the FIRST select call,
 * then returns the inserted rows for insert(notifications).returning() and insert(events).
 */
function createMockDb(edges: MockRow[]) {
	const inserts: Array<{ table: string; values: unknown }> = []
	let nextInsertReturn: unknown = []

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
					then: (resolve: (v: unknown) => void) => resolve(edges),
				}),
			}),
		}),
		insert: (tableRef: { [k: string]: unknown }) => ({
			values: (vals: unknown) => {
				const tableName = (tableRef as { _: { name: string } })._?.name ?? 'unknown'
				inserts.push({ table: tableName, values: vals })
				if (Array.isArray(vals)) {
					nextInsertReturn = vals.map((v, i) => ({ ...(v as object), id: `notif-${i}` }))
				}
				const chain = {
					returning: () => ({
						// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
						then: (resolve: (v: unknown) => void) => resolve(nextInsertReturn),
					}),
					// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
					then: (resolve: (v: unknown) => void) => resolve([]),
				}
				return chain
			},
		}),
	}

	return { db: db as unknown as Database, inserts }
}

describe('notifyParticipants', () => {
	const workspaceId = '00000000-0000-0000-0000-000000000001'
	const objectId = '00000000-0000-0000-0000-000000000002'
	const sourceActor = '00000000-0000-0000-0000-000000000003'
	const assignee = '00000000-0000-0000-0000-000000000004'
	const watcher = '00000000-0000-0000-0000-000000000005'

	it('creates one notification per assignee and watcher minus excluded', async () => {
		const edges: MockRow[] = [
			{ sourceId: objectId, targetId: assignee, type: 'assigned_to' },
			{ sourceId: objectId, targetId: watcher, type: 'watches' },
			{ sourceId: objectId, targetId: sourceActor, type: 'assigned_to' },
		]
		const { db, inserts } = createMockDb(edges)

		const count = await notifyParticipants(db, {
			workspaceId,
			objectId,
			sourceActorId: sourceActor,
			exclude: [sourceActor],
			title: 'Status changed',
		})

		expect(count).toBe(2)
		// First insert is into notifications; second into events
		const notifRows = inserts[0]?.values as Array<{ targetActorId: string }>
		const targets = notifRows.map((r) => r.targetActorId).sort()
		expect(targets).toEqual([assignee, watcher].sort())
	})

	it('returns 0 and writes nothing when there are no participants', async () => {
		const { db, inserts } = createMockDb([])
		const count = await notifyParticipants(db, {
			workspaceId,
			objectId,
			sourceActorId: sourceActor,
			title: 'ignored',
		})
		expect(count).toBe(0)
		expect(inserts).toEqual([])
	})

	it('deduplicates when the same actor is both assignee and watcher', async () => {
		const both = '00000000-0000-0000-0000-000000000006'
		const edges: MockRow[] = [
			{ sourceId: objectId, targetId: both, type: 'assigned_to' },
			{ sourceId: objectId, targetId: both, type: 'watches' },
		]
		const { db, inserts } = createMockDb(edges)
		const count = await notifyParticipants(db, {
			workspaceId,
			objectId,
			sourceActorId: sourceActor,
			title: 'Once',
		})
		expect(count).toBe(1)
		const notifRows = inserts[0]?.values as Array<{ targetActorId: string }>
		expect(notifRows.map((r) => r.targetActorId)).toEqual([both])
	})
})
