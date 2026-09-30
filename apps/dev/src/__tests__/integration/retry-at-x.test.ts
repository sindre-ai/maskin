import {
	events,
	triggerCooldowns,
	triggerEventQueue,
	workspaceSuppressions,
} from '@maskin/db/schema'
import type { PgEvent } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { insertActor, insertSession, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { emitObjectCreated, newQueueRunner, pollUntil, setV2Flag } from './queue-helpers'

// retry_at_x consumer proof for S3 (tech spec §4.6): a credit_exhaustion
// session_failed carrying data.retry_at holds the trigger AND the workspace
// until the provider's reset time, and the queue drains when it arrives. The
// same failure WITHOUT retry_at (the sibling bet has not shipped retryAt yet)
// takes today's exponential backoff, so neither path depends on the sibling.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('S3 — retry_at_x consumer', () => {
	afterEach(() => {
		setV2Flag(null)
		vi.mocked(capturePosthogEvent).mockClear()
	})

	async function seed() {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const target = await insertActor(db, { type: 'agent', name: 'retry_at target' })
		const trig = await insertTrigger(db, ws.id, actorId, target.id, {
			name: 'retry_at trigger',
			type: 'event',
			config: { entity_type: 'object', action: 'created' },
		})
		const session = await insertSession(db, ws.id, target.id, actorId, {
			triggerId: trig.id,
			status: 'failed',
		})
		return { actorId, ws, target, trig, session }
	}

	/** Records a session_failed events row with the given data and emits it, as the session manager does. */
	async function failSession(
		bridge: NodeJS.EventEmitter,
		s: Awaited<ReturnType<typeof seed>>,
		data: Record<string, unknown>,
	) {
		const [row] = await db
			.insert(events)
			.values({
				workspaceId: s.ws.id,
				actorId: s.target.id,
				action: 'session_failed',
				entityType: 'session',
				entityId: s.session.id,
				data,
			})
			.returning({ id: events.id })
		const payload: PgEvent = {
			workspace_id: s.ws.id,
			actor_id: s.target.id,
			action: 'session_failed',
			entity_type: 'session',
			entity_id: s.session.id,
			event_id: String(row.id),
		}
		bridge.emit('event', payload)
	}

	it('with data.retry_at: trigger backoff and workspace suppression both land on that timestamp, and the queue drains when it arrives', async () => {
		const s = await seed()
		setV2Flag(s.ws.id)
		const { bridge, dispatches, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			const retryAt = new Date(Date.now() + 2_000)
			await failSession(bridge, s, {
				classification: 'credit_exhaustion',
				retry_at: retryAt.toISOString(),
			})

			await pollUntil(() => internals.triggerFailures.has(s.trig.id))
			const [cooldown] = await db
				.select()
				.from(triggerCooldowns)
				.where(eq(triggerCooldowns.triggerId, s.trig.id))
			expect(cooldown.backoffUntil.getTime()).toBe(retryAt.getTime())
			expect(cooldown.reason).toBe('retry_at_x')
			const [suppression] = await db
				.select()
				.from(workspaceSuppressions)
				.where(eq(workspaceSuppressions.workspaceId, s.ws.id))
			expect(suppression.suppressedUntil.getTime()).toBe(retryAt.getTime())
			expect(suppression.reason).toBe('retry_at_x')

			// An event arriving inside the window is held, tagged retry_at_x, due at retry_at.
			const heldEventId = await emitObjectCreated(bridge, s.ws.id, s.actorId)
			await pollUntil(async () => {
				const rows = await db
					.select()
					.from(triggerEventQueue)
					.where(eq(triggerEventQueue.workspaceId, s.ws.id))
				return rows.length === 1
			})
			const [held] = await db
				.select()
				.from(triggerEventQueue)
				.where(eq(triggerEventQueue.workspaceId, s.ws.id))
			expect(held.reason).toBe('retry_at_x')
			expect(held.replayAfter.getTime()).toBe(retryAt.getTime())
			expect(dispatches).toHaveLength(0)

			// retry_at arrives; the 30s sweep (called directly here) picks the row up.
			await new Promise((resolve) =>
				setTimeout(resolve, Math.max(0, retryAt.getTime() - Date.now()) + 100),
			)
			await internals.sweepEventQueue()
			await pollUntil(() => dispatches.length === 1)
			expect(dispatches[0]).toMatchObject({ actorId: s.target.id, eventId: heldEventId })
			const replayed = vi
				.mocked(capturePosthogEvent)
				.mock.calls.filter(([name]) => name === 'trigger_event_replayed')
			expect(replayed[0][2]).toMatchObject({ drain_source: 'retry_at_x_arrival' })
		} finally {
			await runner.stop()
		}
	})

	it('without data.retry_at: exponential backoff applies and the workspace is not suppressed', async () => {
		const s = await seed()
		setV2Flag(s.ws.id)
		const { bridge, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			const before = Date.now()
			await failSession(bridge, s, { classification: 'credit_exhaustion' })

			await pollUntil(() => internals.triggerFailures.has(s.trig.id))
			const [cooldown] = await db
				.select()
				.from(triggerCooldowns)
				.where(eq(triggerCooldowns.triggerId, s.trig.id))
			// failure #1: 2^1 * 60s
			expect(cooldown.backoffUntil.getTime() - before).toBeGreaterThanOrEqual(120_000 - 1_000)
			expect(cooldown.backoffUntil.getTime() - before).toBeLessThan(125_000)
			expect(cooldown.reason).toBe('session_failed')
			const suppressions = await db
				.select()
				.from(workspaceSuppressions)
				.where(eq(workspaceSuppressions.workspaceId, s.ws.id))
			expect(suppressions).toHaveLength(0)
		} finally {
			await runner.stop()
		}
	})

	it('with an unusable data.retry_at (past, or not a date): falls back to exponential backoff', async () => {
		for (const retryAt of [new Date(Date.now() - 60_000).toISOString(), 'not-a-date', 12345]) {
			const s = await seed()
			setV2Flag(s.ws.id)
			const { bridge, runner, internals } = newQueueRunner()
			await runner.start()
			try {
				await failSession(bridge, s, { classification: 'credit_exhaustion', retry_at: retryAt })
				await pollUntil(() => internals.triggerFailures.has(s.trig.id))
				const [cooldown] = await db
					.select()
					.from(triggerCooldowns)
					.where(eq(triggerCooldowns.triggerId, s.trig.id))
				expect(cooldown.reason).toBe('session_failed')
				expect(internals.workspaceSuppressions.has(s.ws.id)).toBe(false)
			} finally {
				await runner.stop()
			}
		}
	})

	it('with trigger_engine_v2 off: data.retry_at is ignored', async () => {
		const s = await seed()
		setV2Flag(null)
		const { bridge, runner, internals } = newQueueRunner()
		await runner.start()
		try {
			await failSession(bridge, s, {
				classification: 'credit_exhaustion',
				retry_at: new Date(Date.now() + 10 * 60_000).toISOString(),
			})
			await pollUntil(() => internals.triggerFailures.has(s.trig.id))
			expect(internals.triggerFailures.get(s.trig.id)?.reason).toBe('session_failed')
			expect(internals.workspaceSuppressions.has(s.ws.id)).toBe(false)
		} finally {
			await runner.stop()
		}
	})
})
