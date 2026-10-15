import { triggerCooldowns, triggerEventQueue, triggers } from '@maskin/db/schema'
import type { PgEvent } from '@maskin/realtime'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertActor, insertSession, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { emitObjectCreated, newQueueRunner, pollUntil, setV2Flag } from './queue-helpers'

// S9 proof: resetTriggerBackoff is a queue drain point (S3), so a reset caused
// by the runner's own trigger_fired event drained the queue of a trigger that
// was still cooling. trigger_fired must leave the entry and the queue alone;
// a human edit and a successful session must still drain it.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('S9 — trigger_fired does not drain a cooling trigger', () => {
	afterEach(() => setV2Flag(null))

	/**
	 * A trigger whose window opened, took two held events, and then EXPIRED. The
	 * failure entry stays until a success, an edit or the sweep, which is exactly
	 * when a trigger_fired can arrive for it.
	 */
	async function seedExpiredCooldownWithQueue() {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const target = await insertActor(db, { type: 'agent', name: 'No-drain target' })
		const trig = await insertTrigger(db, ws.id, actorId, target.id, {
			name: 'Cooling trigger',
			type: 'event',
			config: { entity_type: 'object', action: 'created' },
		})
		const session = await insertSession(db, ws.id, target.id, actorId, {
			triggerId: trig.id,
			status: 'completed',
		})
		setV2Flag(ws.id)
		const harness = newQueueRunner()
		await harness.runner.start()

		await harness.internals.recordTriggerFailure(trig.id, 'session_failed')
		await emitObjectCreated(harness.bridge, ws.id, actorId)
		await emitObjectCreated(harness.bridge, ws.id, actorId)
		await pollUntil(async () => (await pendingRows(trig.id)).length === 2)

		// Let the window expire without the entry being cleared.
		const expired = new Date(Date.now() - 1_000)
		const entry = harness.internals.triggerFailures.get(trig.id)
		if (!entry) throw new Error('expected a failure entry')
		entry.backoffUntil = expired
		await db
			.update(triggerCooldowns)
			.set({ backoffUntil: expired })
			.where(eq(triggerCooldowns.triggerId, trig.id))

		return { ...harness, actorId, ws, target, trig, session }
	}

	function pendingRows(triggerId: string) {
		return db
			.select()
			.from(triggerEventQueue)
			.where(and(eq(triggerEventQueue.triggerId, triggerId), isNull(triggerEventQueue.replayedAt)))
	}

	function triggerEvent(
		s: { ws: { id: string }; target: { id: string }; trig: { id: string } },
		action: string,
	): PgEvent {
		return {
			workspace_id: s.ws.id,
			actor_id: s.target.id,
			action,
			entity_type: 'trigger',
			entity_id: s.trig.id,
			event_id: '1',
		}
	}

	it('a trigger_fired event leaves the failure entry and the queued events untouched', async () => {
		const s = await seedExpiredCooldownWithQueue()
		try {
			await s.internals.handleEvent(triggerEvent(s, 'trigger_fired'))
			// A drain (had one started) is async; give it the chance it would have needed.
			await new Promise((resolve) => setTimeout(resolve, 300))

			expect(s.internals.triggerFailures.has(s.trig.id)).toBe(true)
			const cooldowns = await db
				.select()
				.from(triggerCooldowns)
				.where(eq(triggerCooldowns.triggerId, s.trig.id))
			expect(cooldowns).toHaveLength(1)
			expect(await pendingRows(s.trig.id)).toHaveLength(2)
			expect(s.dispatches).toHaveLength(0)
		} finally {
			await s.runner.stop()
		}
	})

	it('a human edit still resets the backoff and drains the queue', async () => {
		const s = await seedExpiredCooldownWithQueue()
		try {
			await db
				.update(triggers)
				.set({ actionPrompt: 'edited by a human' })
				.where(eq(triggers.id, s.trig.id))
			await s.internals.handleEvent(triggerEvent(s, 'updated'))

			await pollUntil(() => s.dispatches.length === 2)
			expect(s.internals.triggerFailures.has(s.trig.id)).toBe(false)
			await pollUntil(async () => (await pendingRows(s.trig.id)).length === 0)
		} finally {
			await s.runner.stop()
		}
	})

	it('a successful session still resets the backoff and drains the queue', async () => {
		const s = await seedExpiredCooldownWithQueue()
		try {
			s.bridge.emit('event', {
				workspace_id: s.ws.id,
				actor_id: s.target.id,
				action: 'session_completed',
				entity_type: 'session',
				entity_id: s.session.id,
				event_id: '1',
			} satisfies PgEvent)

			await pollUntil(() => s.dispatches.length === 2)
			expect(s.internals.triggerFailures.has(s.trig.id)).toBe(false)
			await pollUntil(async () => (await pendingRows(s.trig.id)).length === 0)
		} finally {
			await s.runner.stop()
		}
	})
})
