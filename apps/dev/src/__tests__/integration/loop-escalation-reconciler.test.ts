import { events, triggers } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { FLAGS, type FeatureFlagConfig } from '../../lib/feature-flags'
import { LoopEscalationReconciler } from '../../services/loop-escalation-reconciler'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * D6b — Loops v4 escalation reconciler integration tests.
 *
 * Each spec seeds a fresh workspace, a `loop` object, a child object linked
 * via `in_loop`, one trigger stamped as a "loop step" (D6a's three fields)
 * and — where the acceptance criteria expect an escalation — an unread event
 * on the child object authored by an actor other than the hands-off actor.
 * The reconciler is invoked directly via `tick()`; the setInterval / start /
 * stop machinery is intentionally not exercised here (unit tests cover it),
 * because a 60_000ms tick would be flaky and slow.
 */
describe('LoopEscalationReconciler', () => {
	let workspaceId: string
	let stepAgentId: string
	let handsOffActorId: string
	let escalatesToActorId: string
	let flagOnConfig: FeatureFlagConfig

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id

		const stepAgent = await insertActor(db, { type: 'agent', name: 'Step Agent' })
		stepAgentId = stepAgent.id

		const handsOff = await insertActor(db, { type: 'human', name: 'Downstream Human' })
		handsOffActorId = handsOff.id

		const escalates = await insertActor(db, { type: 'human', name: 'Escalation Owner' })
		escalatesToActorId = escalates.id

		flagOnConfig = {
			testerActorIds: new Set([getTestActorId().toLowerCase()]),
			testerFlags: new Set([FLAGS.loopsV4Polish, FLAGS.loopsV4PolishStepFlow]),
		}
	})

	async function seedLoopWithStep(overrides?: {
		escalateAfterMs?: number | null
		handsOffToActorId?: string | null
		escalatesToActorId?: string | null
		enabled?: boolean
	}) {
		const trigger = await insertTrigger(db, workspaceId, getTestActorId(), stepAgentId, {
			name: 'Draft the memo',
			handsOffToActorId:
				overrides?.handsOffToActorId === undefined ? handsOffActorId : overrides.handsOffToActorId,
			escalatesToActorId:
				overrides?.escalatesToActorId === undefined
					? escalatesToActorId
					: overrides.escalatesToActorId,
			escalateAfterMs: overrides?.escalateAfterMs === undefined ? 1_000 : overrides.escalateAfterMs,
			enabled: overrides?.enabled ?? true,
		})

		const loop = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'loop',
			title: 'Publication loop',
			status: 'running',
			metadata: { trigger_ids: [trigger.id] },
		})

		const child = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			title: 'Ship draft',
			status: 'todo',
		})

		await insertRelationship(db, getTestActorId(), {
			sourceType: 'object',
			sourceId: loop.id,
			targetType: 'object',
			targetId: child.id,
			type: 'in_loop',
		})

		return { trigger, loop, child }
	}

	async function seedUnreadEventOn(childId: string, ageMs: number) {
		// Author with the step agent, not the hands-off actor, so the event
		// counts as unread from the hands-off actor's point of view (their
		// read_state row is missing entirely — COALESCE(..., 0) treats it as
		// "unread from the beginning of time").
		const createdAt = new Date(Date.now() - ageMs)
		await db.insert(events).values({
			workspaceId,
			actorId: stepAgentId,
			action: 'updated',
			entityType: 'task',
			entityId: childId,
			data: { changes: [] },
			createdAt,
		})
	}

	async function countEscalationCommentsFor(loopId: string): Promise<number> {
		const rows = await db
			.select({ id: events.id, data: events.data })
			.from(events)
			.where(and(eq(events.entityId, loopId), eq(events.action, 'commented')))
			.orderBy(desc(events.id))
		return rows.filter((r) => {
			const data = (r.data ?? {}) as { content?: string }
			return typeof data.content === 'string' && data.content.startsWith('Escalating:')
		}).length
	}

	it('posts exactly one attention-4 escalation comment for a step whose wait exceeds escalate_after_ms', async () => {
		const { trigger, loop, child } = await seedLoopWithStep({ escalateAfterMs: 1_000 })
		await seedUnreadEventOn(child.id, 5_000) // 5s old — well past 1s threshold

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await reconciler.tick()

		const comments = await db
			.select({
				actorId: events.actorId,
				data: events.data,
			})
			.from(events)
			.where(and(eq(events.entityId, loop.id), eq(events.action, 'commented')))

		expect(comments).toHaveLength(1)
		const posted = comments[0]
		expect(posted.actorId).toBe(stepAgentId)
		const data = (posted.data ?? {}) as {
			content: string
			attention: number
			mentions: string[]
		}
		expect(data.attention).toBe(4)
		expect(data.mentions).toEqual([escalatesToActorId])
		expect(data.content).toMatch(/^Escalating: Draft the memo has been waiting/)
		expect(data.content).toContain('Downstream Human')

		// Second tick MUST NOT double-post — per-wait-spell idempotency guard.
		await reconciler.tick()
		expect(await countEscalationCommentsFor(loop.id)).toBe(1)

		// last_escalated_at is stamped so subsequent ticks skip the same spell.
		const [row] = await db
			.select({ lastEscalatedAt: triggers.lastEscalatedAt })
			.from(triggers)
			.where(eq(triggers.id, trigger.id))
		expect(row.lastEscalatedAt).toBeInstanceOf(Date)
	})

	it('posts zero comments when the hands-off actor has no unread events (waitingOnViewer=false)', async () => {
		const { loop } = await seedLoopWithStep({ escalateAfterMs: 1_000 })
		// No events on the child object at all — the hands-off actor is caught
		// up by definition.

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(0)
	})

	it('posts zero comments when escalate_after_ms is null even if the actor is waiting', async () => {
		const { loop, child } = await seedLoopWithStep({ escalateAfterMs: null })
		await seedUnreadEventOn(child.id, 5_000)

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(0)
	})

	it('posts zero comments when the umbrella loops-v4-polish flag is off (rollback path)', async () => {
		const { loop, child } = await seedLoopWithStep({ escalateAfterMs: 1_000 })
		await seedUnreadEventOn(child.id, 5_000)

		const flagOffConfig: FeatureFlagConfig = {
			testerActorIds: new Set([getTestActorId().toLowerCase()]),
			// Umbrella missing, sub-flag present — still off, because the sub-flag
			// is gated by the umbrella at the read site (per the SPEC).
			testerFlags: new Set([FLAGS.loopsV4PolishStepFlow]),
		}
		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOffConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(0)
	})

	it('posts zero comments when the sub-flag loops-v4-polish.step_flow is off', async () => {
		const { loop, child } = await seedLoopWithStep({ escalateAfterMs: 1_000 })
		await seedUnreadEventOn(child.id, 5_000)

		const subFlagOffConfig: FeatureFlagConfig = {
			testerActorIds: new Set([getTestActorId().toLowerCase()]),
			testerFlags: new Set([FLAGS.loopsV4Polish]),
		}
		const reconciler = new LoopEscalationReconciler(db, 60_000, () => subFlagOffConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(0)
	})

	it('re-escalates when a fresh unread event lands after last_escalated_at (new wait spell)', async () => {
		// Seeds the "new wait spell" state directly rather than driving it
		// through a full first-tick + read-catch-up + fresh-event sequence.
		// The cursor rule under test is purely a comparison between
		// `last_escalated_at` and the oldest unread event's `created_at`; the
		// test asserts that comparison in isolation.
		const { trigger, loop, child } = await seedLoopWithStep({ escalateAfterMs: 1_000 })

		// last_escalated_at parked in the past — as if a prior spell already
		// escalated a while ago. The reconciler MUST NOT treat this as an
		// active suppression when the current spell's events are all newer.
		const priorEscalation = new Date(Date.now() - 60 * 60_000)
		await db
			.update(triggers)
			.set({ lastEscalatedAt: priorEscalation })
			.where(eq(triggers.id, trigger.id))

		// A single unread event, 5s old — all events in the current spell are
		// newer than `priorEscalation`, so this is a "new wait spell".
		await seedUnreadEventOn(child.id, 5_000)

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(1)
		const [row] = await db
			.select({ lastEscalatedAt: triggers.lastEscalatedAt })
			.from(triggers)
			.where(eq(triggers.id, trigger.id))
		expect(row.lastEscalatedAt).not.toBeNull()
		const stamped = row.lastEscalatedAt as Date
		expect(stamped.getTime()).toBeGreaterThan(priorEscalation.getTime())
	})

	it('suppresses re-escalation when last_escalated_at is at or after the current wait spell start', async () => {
		// Direct DB seed of the "already-escalated-for-this-spell" state.
		// waitingSince (from unread event) = 5s ago; last_escalated_at = 2s
		// ago (i.e. AFTER the wait spell began). Nothing should post.
		const { trigger, loop, child } = await seedLoopWithStep({ escalateAfterMs: 1_000 })
		await seedUnreadEventOn(child.id, 5_000)

		const alreadyEscalated = new Date(Date.now() - 2_000)
		await db
			.update(triggers)
			.set({ lastEscalatedAt: alreadyEscalated })
			.where(eq(triggers.id, trigger.id))

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(0)
	})

	it('skips triggers whose enabled=false even when hand-off + escalates + escalate_after_ms are all set', async () => {
		const { loop, child } = await seedLoopWithStep({ escalateAfterMs: 1_000, enabled: false })
		await seedUnreadEventOn(child.id, 5_000)

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await reconciler.tick()

		expect(await countEscalationCommentsFor(loop.id)).toBe(0)
	})

	it('skips triggers with no parent loop (orphan step)', async () => {
		// Trigger has the three fields set but no loop object references it via
		// metadata.trigger_ids. The reconciler must not crash and must post
		// nothing (there is no loop to post the comment on).
		const trigger = await insertTrigger(db, workspaceId, getTestActorId(), stepAgentId, {
			handsOffToActorId: handsOffActorId,
			escalatesToActorId,
			escalateAfterMs: 1_000,
		})

		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await expect(reconciler.tick()).resolves.not.toThrow()

		const commentCount = await db
			.select({ id: events.id })
			.from(events)
			.where(eq(events.action, 'commented'))
		expect(commentCount).toHaveLength(0)

		// Sanity: the trigger row survives untouched.
		const [row] = await db
			.select({ lastEscalatedAt: triggers.lastEscalatedAt })
			.from(triggers)
			.where(eq(triggers.id, trigger.id))
		expect(row.lastEscalatedAt).toBeNull()
	})

	it('is a no-op when there are no candidate steps to consider', async () => {
		// Fresh workspace, no triggers seeded.
		const reconciler = new LoopEscalationReconciler(db, 60_000, () => flagOnConfig)
		await expect(reconciler.tick()).resolves.not.toThrow()
	})
})
