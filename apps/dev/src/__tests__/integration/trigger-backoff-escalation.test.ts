import { triggerCooldowns } from '@maskin/db/schema'
import type { PgEvent } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { newQueueRunner } from './queue-helpers'

// S9 proof: the runner's own trigger_fired event (entity_type 'trigger') used
// to reach handleTriggerChange, which reset that trigger's backoff. A trigger
// that keeps failing therefore cleared its own window each time it fired and
// never climbed past the first step. With trigger_fired interleaved between
// every failure, the windows must still double: 2, 4, 8, 16 minutes.

const MINUTE_MS = 60_000

describe('S9 — backoff escalates with trigger_fired events interleaved', () => {
	it('a trigger failing 4 times in a row backs off 2, 4, 8, 16 minutes', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const target = await insertActor(db, { type: 'agent', name: 'Escalation target' })
		const trig = await insertTrigger(db, ws.id, actorId, target.id, {
			name: 'Failing trigger',
			type: 'event',
			config: { entity_type: 'object', action: 'created' },
		})
		const { runner, internals } = newQueueRunner()
		await runner.start()
		try {
			const triggerFired: PgEvent = {
				workspace_id: ws.id,
				actor_id: target.id,
				action: 'trigger_fired',
				entity_type: 'trigger',
				entity_id: trig.id,
				event_id: '1',
			}

			const windowsMinutes: number[] = []
			for (let failure = 1; failure <= 4; failure++) {
				await internals.recordTriggerFailure(trig.id, 'session_failed')
				// The runner writes trigger_fired about itself after every dispatch.
				await internals.handleEvent(triggerFired)

				const [row] = await db
					.select()
					.from(triggerCooldowns)
					.where(eq(triggerCooldowns.triggerId, trig.id))
				expect(row.count).toBe(failure)
				windowsMinutes.push(
					Math.round((row.backoffUntil.getTime() - row.lastFailedAt.getTime()) / MINUTE_MS),
				)
			}

			expect(windowsMinutes).toEqual([2, 4, 8, 16])
			expect(internals.triggerFailures.get(trig.id)?.count).toBe(4)
		} finally {
			await runner.stop()
		}
	})
})
