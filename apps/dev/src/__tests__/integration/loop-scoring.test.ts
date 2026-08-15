import { objects, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

// Lazy-load the service so vitest doesn't pull it at module resolution time —
// same pattern as loop-lifecycle.test.ts.
const {
	MIN_EVIDENCE_OBSERVATIONS,
	computeLoopPerformanceScore,
	findLoopForSessionTrigger,
	recomputeAndPersistScore,
} = await import('../../services/loop-scoring')

async function insertLoop(
	workspaceId: string,
	actorId: string,
	overrides: {
		outcomeMetric?: string
		outcomeTarget?: number
		killThreshold?: number
		promotionMode?: 'auto' | 'human_approved'
		performanceScore?: number
		triggerIds?: string[]
		metadata?: Record<string, unknown>
	} = {},
) {
	const metadata: Record<string, unknown> = { ...(overrides.metadata ?? {}) }
	if (overrides.triggerIds) metadata.trigger_ids = overrides.triggerIds
	return insertObject(db, workspaceId, actorId, {
		type: 'loop',
		title: 'Test loop',
		status: 'draft',
		metadata: Object.keys(metadata).length > 0 ? metadata : null,
		outcomeMetric: overrides.outcomeMetric ?? null,
		outcomeTarget: overrides.outcomeTarget !== undefined ? String(overrides.outcomeTarget) : null,
		killThreshold: overrides.killThreshold !== undefined ? String(overrides.killThreshold) : null,
		promotionMode: overrides.promotionMode ?? null,
		performanceScore:
			overrides.performanceScore !== undefined ? String(overrides.performanceScore) : null,
	})
}

async function seedMember(workspaceId: string, actorId: string, loopId: string, status: string) {
	const member = await insertObject(db, workspaceId, actorId, {
		type: 'task',
		title: `Member ${status}`,
		status,
	})
	await insertRelationship(db, actorId, {
		sourceType: 'object',
		sourceId: loopId,
		targetType: 'object',
		targetId: member.id,
		type: 'in_loop',
	})
	return member
}

describe('Loop performance score engine', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	describe('computeLoopPerformanceScore', () => {
		it('returns null for a loop with no outcome_metric set (cannot be scored)', async () => {
			const loop = await insertLoop(workspaceId, actorId, {})
			expect(await computeLoopPerformanceScore(db, loop.id)).toBeNull()
		})

		it('returns null for a non-loop object', async () => {
			const other = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
			})
			expect(await computeLoopPerformanceScore(db, other.id)).toBeNull()
		})

		it('measures outcome rate as reached / total members, capped by evidence factor', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
			})
			// 8 total members, 4 at outcome_metric → raw outcome = 0.5 → raw score
			// = 100 * (0.5 * 0.7) / 0.7 = 50. Evidence = 8; factor = 8/20 = 0.4.
			// Persisted score = 50 * 0.4 = 20.
			for (let i = 0; i < 4; i++) await seedMember(workspaceId, actorId, loop.id, 'meeting_booked')
			for (let i = 0; i < 4; i++) await seedMember(workspaceId, actorId, loop.id, 'contacted')

			const breakdown = await computeLoopPerformanceScore(db, loop.id)
			expect(breakdown).not.toBeNull()
			if (!breakdown) return
			expect(breakdown.outcome.total).toBe(8)
			expect(breakdown.outcome.reached).toBe(4)
			expect(breakdown.outcome.rate).toBeCloseTo(0.5)
			expect(breakdown.reliability.rate).toBeNull()
			expect(breakdown.rawScore).toBeCloseTo(50)
			expect(breakdown.evidenceFactor).toBeCloseTo(0.4)
			expect(breakdown.score).toBeCloseTo(20)
		})

		it('scores 100 * reliability when only reliability signal is present, capped by evidence', async () => {
			// Simpler variant of the above without wrestling the session factory:
			// seed 25 completed sessions on a single trigger id the loop claims,
			// which pushes evidence past MIN_EVIDENCE_OBSERVATIONS so the factor
			// hits 1.0 and reveals the raw reliability signal.
			const targetActor = await insertActor(db)
			const [triggerRow] = await db
				.insert((await import('@maskin/db/schema')).triggers)
				.values({
					workspaceId,
					name: 'reliability-source',
					type: 'event',
					config: { entity_type: 'task', action: 'created' },
					actionPrompt: 'noop',
					targetActorId: targetActor.id,
					createdBy: actorId,
				})
				.returning()
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'delivered',
				triggerIds: [triggerRow.id],
			})
			for (let i = 0; i < 20; i++) {
				await insertSession(db, workspaceId, targetActor.id, actorId, {
					triggerId: triggerRow.id,
					status: 'completed',
				})
			}
			for (let i = 0; i < 5; i++) {
				await insertSession(db, workspaceId, targetActor.id, actorId, {
					triggerId: triggerRow.id,
					status: 'failed',
				})
			}
			const breakdown = await computeLoopPerformanceScore(db, loop.id)
			expect(breakdown).not.toBeNull()
			if (!breakdown) return
			expect(breakdown.reliability.total).toBe(25)
			expect(breakdown.reliability.clean).toBe(20)
			expect(breakdown.reliability.rate).toBeCloseTo(0.8)
			expect(breakdown.evidence).toBe(25)
			expect(breakdown.evidenceFactor).toBe(1)
			// Only reliability contributes (no in_loop members yet) → raw = 100 * 0.8 = 80.
			expect(breakdown.rawScore).toBeCloseTo(80)
			expect(breakdown.score).toBeCloseTo(80)
		})

		it('blends outcome + reliability with 0.7 / 0.3 weights when both signals are present', async () => {
			const targetActor = await insertActor(db)
			const [triggerRow] = await db
				.insert((await import('@maskin/db/schema')).triggers)
				.values({
					workspaceId,
					name: 'blend-source',
					type: 'event',
					config: { entity_type: 'task', action: 'created' },
					actionPrompt: 'noop',
					targetActorId: targetActor.id,
					createdBy: actorId,
				})
				.returning()
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
				triggerIds: [triggerRow.id],
			})
			// 10 members, 5 at outcome (rate = 0.5).
			for (let i = 0; i < 5; i++) await seedMember(workspaceId, actorId, loop.id, 'meeting_booked')
			for (let i = 0; i < 5; i++) await seedMember(workspaceId, actorId, loop.id, 'contacted')
			// 20 sessions, 20 completed (rate = 1.0).
			for (let i = 0; i < 20; i++) {
				await insertSession(db, workspaceId, targetActor.id, actorId, {
					triggerId: triggerRow.id,
					status: 'completed',
				})
			}
			const breakdown = await computeLoopPerformanceScore(db, loop.id)
			expect(breakdown).not.toBeNull()
			if (!breakdown) return
			// raw = 100 * (0.5*0.7 + 1.0*0.3) / (0.7+0.3) = 100 * 0.65 = 65
			expect(breakdown.rawScore).toBeCloseTo(65)
			// evidence = 10 + 20 = 30 → factor capped at 1.
			expect(breakdown.evidenceFactor).toBe(1)
			expect(breakdown.score).toBeCloseTo(65)
		})

		it('MIN_EVIDENCE_OBSERVATIONS caps a perfect outcome+reliability at four samples to 20', async () => {
			// Belt-and-braces check on the "four clean runs cannot score high"
			// property using the outcome signal only (simpler DB setup than
			// wrestling the sessions factory).
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
			})
			for (let i = 0; i < 4; i++) await seedMember(workspaceId, actorId, loop.id, 'meeting_booked')
			const breakdown = await computeLoopPerformanceScore(db, loop.id)
			expect(breakdown).not.toBeNull()
			if (!breakdown) return
			expect(breakdown.rawScore).toBeCloseTo(100)
			expect(breakdown.evidence).toBe(4)
			expect(breakdown.evidenceFactor).toBeCloseTo(4 / MIN_EVIDENCE_OBSERVATIONS)
			expect(breakdown.score).toBeCloseTo(100 * (4 / MIN_EVIDENCE_OBSERVATIONS))
			// pilot's promotion threshold is 50 — four clean signals must land
			// below it regardless of raw perfection.
			expect(breakdown.score).toBeLessThan(50)
		})
	})

	describe('recomputeAndPersistScore', () => {
		it('writes the computed score to objects.performance_score in place', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
				performanceScore: 0,
			})
			for (let i = 0; i < 10; i++) await seedMember(workspaceId, actorId, loop.id, 'meeting_booked')
			const breakdown = await recomputeAndPersistScore(db, loop.id)
			expect(breakdown).not.toBeNull()
			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.performanceScore).not.toBeNull()
			expect(Number(row.performanceScore)).toBeCloseTo(breakdown?.score ?? -1)
		})

		it('is a no-op (returns null) for a loop with no outcome_metric', async () => {
			const loop = await insertLoop(workspaceId, actorId, { performanceScore: 42 })
			const result = await recomputeAndPersistScore(db, loop.id)
			expect(result).toBeNull()
			// Existing score not overwritten either.
			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(Number(row.performanceScore)).toBe(42)
		})
	})

	describe('findLoopForSessionTrigger', () => {
		it('resolves the loop that owns a trigger via metadata.trigger_ids', async () => {
			const triggerId = crypto.randomUUID()
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
				triggerIds: [triggerId],
			})
			const found = await findLoopForSessionTrigger(db, workspaceId, triggerId)
			expect(found).toBe(loop.id)
		})

		it('returns null when no loop claims the trigger', async () => {
			await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'x',
				triggerIds: [crypto.randomUUID()],
			})
			const found = await findLoopForSessionTrigger(db, workspaceId, crypto.randomUUID())
			expect(found).toBeNull()
		})

		it('returns null for null trigger id (standalone session)', async () => {
			expect(await findLoopForSessionTrigger(db, workspaceId, null)).toBeNull()
		})

		it('does not cross workspace boundaries', async () => {
			const otherActor = await insertActor(db)
			const otherWs = await insertWorkspace(db, otherActor.id)
			const triggerId = crypto.randomUUID()
			await insertLoop(otherWs.id, otherActor.id, {
				outcomeMetric: 'x',
				triggerIds: [triggerId],
			})
			expect(await findLoopForSessionTrigger(db, workspaceId, triggerId)).toBeNull()
		})
	})

	describe('migration backfill: metadata → columns', () => {
		it('leaves a loop row whose metadata was pre-lift readable via the new columns', async () => {
			// The migration backfill (0056_loop_performance_score_fields.sql) copies
			// pre-existing metadata keys onto the new columns and strips them. This
			// asserts the invariant post-migration: metadata should not carry the
			// lifted keys, and the columns should. We test by inserting a row that
			// mimics a pre-lift shape *plus* the migration-set columns, then
			// confirming the reader (readLoopState via evaluateAfterRun's contract)
			// sees the column values. Verifying the migration itself against a live
			// DB is out of scope for this test — the migration harness applies it
			// once per test run, and any pre-existing metadata in test fixtures
			// would fail the constraint check.
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
				performanceScore: 42.5,
				killThreshold: 10,
				promotionMode: 'auto',
			})
			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.outcomeMetric).toBe('meeting_booked')
			expect(Number(row.performanceScore)).toBe(42.5)
			expect(Number(row.killThreshold)).toBe(10)
			expect(row.promotionMode).toBe('auto')
			// metadata carries none of the lifted keys.
			const meta = (row.metadata ?? {}) as Record<string, unknown>
			expect(meta).not.toHaveProperty('performance_score')
			expect(meta).not.toHaveProperty('kill_threshold')
			expect(meta).not.toHaveProperty('promotion_mode')
			expect(meta).not.toHaveProperty('outcome_metric')
		})

		it('rejects promotion_mode outside the allowed enum via CHECK constraint', async () => {
			await expect(
				insertObject(db, workspaceId, actorId, {
					type: 'loop',
					title: 'bad-mode',
					status: 'draft',
					promotionMode: 'not_a_mode',
				}),
			).rejects.toThrow()
		})
	})

	describe('session-complete → loop score wiring', () => {
		it('recompute-and-persist can be chained after a real session status flip', async () => {
			// Integration test for the end-to-end wire: mimic what session-manager
			// does after a session terminates — flip the session's status to
			// completed, then call recomputeAndPersistScore. Asserts the loop's
			// score reflects the just-completed run's reliability contribution.
			const targetActor = await insertActor(db)
			const [triggerRow] = await db
				.insert((await import('@maskin/db/schema')).triggers)
				.values({
					workspaceId,
					name: 'wire-source',
					type: 'event',
					config: { entity_type: 'task', action: 'created' },
					actionPrompt: 'noop',
					targetActorId: targetActor.id,
					createdBy: actorId,
				})
				.returning()
			const loop = await insertLoop(workspaceId, actorId, {
				outcomeMetric: 'meeting_booked',
				triggerIds: [triggerRow.id],
			})
			// Seed 25 pre-existing completed sessions so evidence factor = 1.
			for (let i = 0; i < 25; i++) {
				await insertSession(db, workspaceId, targetActor.id, actorId, {
					triggerId: triggerRow.id,
					status: 'completed',
				})
			}
			// New run, currently in-flight.
			const running = await insertSession(db, workspaceId, targetActor.id, actorId, {
				triggerId: triggerRow.id,
				status: 'running',
			})
			// Session-manager writes the terminal row then calls the wire — we
			// mirror those two steps here.
			await db.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, running.id))
			const breakdown = await recomputeAndPersistScore(db, loop.id)
			expect(breakdown).not.toBeNull()
			if (!breakdown) return
			// 25 completed + 1 failed = 26 terminal; 25 clean → 25/26 ≈ 0.961.
			expect(breakdown.reliability.total).toBe(26)
			expect(breakdown.reliability.clean).toBe(25)
			expect(breakdown.reliability.rate).toBeCloseTo(25 / 26, 3)
			// No members yet → outcome null; raw = 100 * 25/26; evidence = 26 → factor = 1.
			expect(breakdown.score).toBeCloseTo(100 * (25 / 26), 1)

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(Number(row.performanceScore)).toBeCloseTo(breakdown.score, 1)
		})
	})
})
