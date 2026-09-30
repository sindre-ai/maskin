import { events, triggerEventQueue } from '@maskin/db/schema'
import { and, count, eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { TRIGGER_QUEUE_CAP, WORKSPACE_QUEUE_CAP } from '../../services/trigger-event-queue'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { emitObjectCreated, newQueueRunner, pollUntil, setV2Flag } from './queue-helpers'

// Backpressure proof for S3 (tech spec §4.5): at the per-trigger or
// per-workspace cap the event is dropped and trigger_queue_overflow is
// recorded instead of a row.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('S3 — queue backpressure', () => {
	afterEach(async () => {
		setV2Flag(null)
		vi.mocked(capturePosthogEvent).mockClear()
		// Drop the ~110k seeded rows so later integration files do not inherit them.
		await db.delete(triggerEventQueue)
	})

	async function overflowEvents(entityId: string) {
		return db
			.select()
			.from(events)
			.where(and(eq(events.action, 'trigger_queue_overflow'), eq(events.entityId, entityId)))
	}

	it('drops the event and records trigger_queue_overflow at the per-trigger cap', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const target = await insertActor(db, { type: 'agent', name: 'Overflow target' })
		const trig = await insertTrigger(db, ws.id, actorId, target.id, {
			name: 'Overflow trigger',
			type: 'event',
			config: { entity_type: 'object', action: 'created' },
		})
		setV2Flag(ws.id)
		await db.execute(sql`
			INSERT INTO trigger_event_queue (workspace_id, trigger_id, event_id, event_snapshot, replay_after, reason)
			SELECT ${ws.id}::uuid, ${trig.id}::uuid, g, '{}'::jsonb, now() + interval '1 hour', 'trigger_backoff'
			FROM generate_series(1, ${TRIGGER_QUEUE_CAP}) AS g`)

		const { bridge, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await internals.recordTriggerFailure(trig.id, 'session_failed')
			const droppedEventId = await emitObjectCreated(bridge, ws.id, actorId)

			await pollUntil(async () => (await overflowEvents(trig.id)).length === 1)
			const [overflow] = await overflowEvents(trig.id)
			expect(overflow.entityType).toBe('trigger_event_queue')
			expect(overflow.data).toMatchObject({
				event_id: String(droppedEventId),
				reason: 'trigger_backoff',
				scope: 'trigger',
				current_depth: TRIGGER_QUEUE_CAP,
			})

			const [{ n }] = await db
				.select({ n: count() })
				.from(triggerEventQueue)
				.where(eq(triggerEventQueue.triggerId, trig.id))
			expect(n).toBe(TRIGGER_QUEUE_CAP)
			const queued = vi
				.mocked(capturePosthogEvent)
				.mock.calls.filter(([name]) => name === 'trigger_event_queued')
			expect(queued).toHaveLength(0)
		} finally {
			await runner.stop()
		}
	})

	it('drops the event and records trigger_queue_overflow at the per-workspace cap', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		setV2Flag(ws.id)
		await db.execute(sql`
			INSERT INTO trigger_event_queue (workspace_id, trigger_id, event_id, event_snapshot, replay_after, reason)
			SELECT ${ws.id}::uuid, NULL, g, '{}'::jsonb, now() + interval '1 hour', 'workspace_suppression'
			FROM generate_series(1, ${WORKSPACE_QUEUE_CAP}) AS g`)

		const { bridge, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await internals.suppressWorkspace(ws.id, {
				until: new Date(Date.now() + 60 * 60_000),
				reason: 'no LLM credentials connected for this workspace',
			})
			await emitObjectCreated(bridge, ws.id, actorId)

			await pollUntil(async () => (await overflowEvents(ws.id)).length === 1)
			const [overflow] = await overflowEvents(ws.id)
			expect(overflow.data).toMatchObject({
				scope: 'workspace',
				reason: 'workspace_suppression',
				current_depth: WORKSPACE_QUEUE_CAP,
			})
			const [{ n }] = await db
				.select({ n: count() })
				.from(triggerEventQueue)
				.where(eq(triggerEventQueue.workspaceId, ws.id))
			expect(n).toBe(WORKSPACE_QUEUE_CAP)
		} finally {
			await runner.stop()
		}
	})
})
