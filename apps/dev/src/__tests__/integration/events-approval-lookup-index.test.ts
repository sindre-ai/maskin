import { randomUUID } from 'node:crypto'
import { events } from '@maskin/db/schema'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { DELIVERED_ACTION } from '../../lib/object-delivery'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const INDEX_NAME = 'events_approval_lookup_idx'

describe('events_approval_lookup_idx (migration 0170)', () => {
	it('exists, is valid, and is a partial index over the three approval actions', async () => {
		const rows = await db.execute<{ indexdef: string; indisvalid: boolean }>(sql`
			SELECT pg_indexes.indexdef, pg_index.indisvalid
			FROM pg_indexes
			JOIN pg_class ON pg_class.relname = pg_indexes.indexname
			JOIN pg_index ON pg_index.indexrelid = pg_class.oid
			WHERE pg_indexes.tablename = 'events' AND pg_indexes.indexname = ${INDEX_NAME}`)
		const [row] = Array.from(rows)
		expect(row).toBeDefined()
		expect(row?.indisvalid).toBe(true)
		expect(row?.indexdef).toContain('(workspace_id, entity_id, id)')
		for (const action of ['approved', 'delivered', 'auto_sent']) {
			expect(row?.indexdef).toContain(`'${action}'::text`)
		}
	})

	it('is what the planner picks for the delivery lookup on an object with many other events', async () => {
		// latestEvent (lib/object-delivery.ts) asks for the newest event of one action on one object.
		// On a busy object the index on (workspace, entity, id) alone would read every event of it;
		// the partial index holds only the few approval events. Give the object a long history so the
		// planner can see the difference, then explain the query as the app sends it, with the action
		// as a bound parameter.
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const entityId = randomUUID()
		await db.insert(events).values(
			Array.from({ length: 3_000 }, () => ({
				workspaceId: ws.id,
				actorId,
				action: 'updated',
				entityType: 'object',
				entityId,
			})),
		)
		await db.insert(events).values({
			workspaceId: ws.id,
			actorId,
			action: DELIVERED_ACTION,
			entityType: 'object',
			entityId,
			data: { content_hash: 'h' },
		})
		await db.execute(sql`ANALYZE events`)

		const plan = await db.$client.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off')
			const rows = await tx.unsafe(
				`EXPLAIN SELECT id FROM events
				 WHERE workspace_id = $1 AND entity_id = $2 AND action = $3
				 ORDER BY id DESC LIMIT 1`,
				[ws.id, entityId, DELIVERED_ACTION] as never[],
			)
			return Array.from(rows as unknown as Record<string, string>[])
				.map((r) => r['QUERY PLAN'])
				.join('\n')
		})
		expect(plan).toContain(INDEX_NAME)
	})
})
