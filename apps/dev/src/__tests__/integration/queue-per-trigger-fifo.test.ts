import { triggerEventQueue } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { emitObjectCreated, newQueueRunner, pollUntil, setV2Flag } from './queue-helpers'

// Per-trigger FIFO proof for S3 (tech spec §4.3): a cooling trigger's held
// events replay in event_id order while a healthy sibling keeps firing.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('S3 — per-trigger FIFO through the event queue', () => {
	afterEach(() => setV2Flag(null))

	it('cool one trigger, fire 5 events, unfreeze: its events replay in order; the healthy trigger fired all 5 meanwhile', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const coolingTarget = await insertActor(db, { type: 'agent', name: 'Cooling target' })
		const healthyTarget = await insertActor(db, { type: 'agent', name: 'Healthy target' })
		const config = { entity_type: 'object', action: 'created' }
		const cooling = await insertTrigger(db, ws.id, actorId, coolingTarget.id, {
			name: 'Cooling trigger',
			type: 'event',
			config,
		})
		await insertTrigger(db, ws.id, actorId, healthyTarget.id, {
			name: 'Healthy trigger',
			type: 'event',
			config,
		})
		setV2Flag(ws.id)

		const { bridge, dispatches, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await internals.recordTriggerFailure(cooling.id, 'session_failed')

			const eventIds: number[] = []
			for (let i = 0; i < 5; i++) eventIds.push(await emitObjectCreated(bridge, ws.id, actorId))

			await pollUntil(() => dispatches.filter((d) => d.actorId === healthyTarget.id).length === 5)
			await pollUntil(async () => {
				const rows = await db
					.select()
					.from(triggerEventQueue)
					.where(eq(triggerEventQueue.triggerId, cooling.id))
				return rows.length === 5
			})
			const held = await db
				.select()
				.from(triggerEventQueue)
				.where(eq(triggerEventQueue.triggerId, cooling.id))
			expect(held.every((r) => r.reason === 'trigger_backoff')).toBe(true)
			expect(dispatches.filter((d) => d.actorId === coolingTarget.id)).toHaveLength(0)

			await internals.resetTriggerBackoff(cooling.id)
			await pollUntil(() => dispatches.filter((d) => d.actorId === coolingTarget.id).length === 5)

			const replayed = dispatches
				.filter((d) => d.actorId === coolingTarget.id)
				.map((d) => d.eventId)
			expect(replayed).toEqual([...eventIds].sort((a, b) => a - b))
			// The healthy trigger was not re-dispatched by the replay.
			expect(dispatches.filter((d) => d.actorId === healthyTarget.id)).toHaveLength(5)
			// Rows are marked replayed in the drain's transaction, which commits after the last dispatch.
			await pollUntil(async () => {
				const pending = await db
					.select()
					.from(triggerEventQueue)
					.where(
						and(eq(triggerEventQueue.triggerId, cooling.id), isNull(triggerEventQueue.replayedAt)),
					)
				return pending.length === 0
			})
		} finally {
			await runner.stop()
		}
	})
})
