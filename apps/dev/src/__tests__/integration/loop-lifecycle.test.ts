import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, loopPromotionProposals, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// Lazy-load routes to match the pattern used by the other integration tests
// in this directory — vitest doesn't pull them at module-resolution time.
const { default: loopPromotionsRoutes } = await import('../../routes/loop-promotions')
const { breachGuardrail, evaluateAfterRun } = await import('../../services/loop-lifecycle')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

function makeApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/loop-promotions', loopPromotionsRoutes)
	return app
}

async function insertLoop(
	workspaceId: string,
	actorId: string,
	overrides: {
		status?: string
		metadata?: Record<string, unknown>
		title?: string
	} = {},
) {
	return insertObject(db, workspaceId, actorId, {
		type: 'loop',
		title: overrides.title ?? 'Test loop',
		status: overrides.status ?? 'draft',
		metadata: overrides.metadata ?? null,
	})
}

describe('Loop lifecycle promotion/demotion service', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	describe('evaluateAfterRun — promotion', () => {
		it('does nothing when the score is below the rung threshold', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'draft',
				metadata: {
					performance_score: 10,
					kill_threshold: 5,
					promotion_mode: 'human_approved',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result).toEqual({ kind: 'no_change' })

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('draft')

			const proposals = await db
				.select()
				.from(loopPromotionProposals)
				.where(eq(loopPromotionProposals.loopId, loop.id))
			expect(proposals.length).toBe(0)
		})

		it('auto-promotes when score crosses threshold and mode is auto', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'draft',
				metadata: {
					performance_score: 25,
					kill_threshold: 5,
					promotion_mode: 'auto',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result.kind).toBe('promoted')
			if (result.kind !== 'promoted') return
			expect(result.from).toBe('draft')
			expect(result.to).toBe('pilot')
			expect(result.mode).toBe('auto')

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('pilot')

			// No proposal row on auto-advance — the audit event carries the change.
			const proposals = await db
				.select()
				.from(loopPromotionProposals)
				.where(eq(loopPromotionProposals.loopId, loop.id))
			expect(proposals.length).toBe(0)

			const promotedEvents = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_promoted')))
			expect(promotedEvents.length).toBe(1)
			const data = promotedEvents[0].data as {
				mode: string
				from_status: string
				to_status: string
			}
			expect(data.mode).toBe('auto')
			expect(data.from_status).toBe('draft')
			expect(data.to_status).toBe('pilot')
		})

		it('enqueues a pending proposal for human_approved mode; loop stays at current rung', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'pilot',
				metadata: {
					performance_score: 55,
					kill_threshold: 10,
					promotion_mode: 'human_approved',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result.kind).toBe('proposed')
			if (result.kind !== 'proposed') return
			expect(result.from).toBe('pilot')
			expect(result.to).toBe('supervised')

			// Loop stays on pilot until a human approves.
			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('pilot')

			const [proposal] = await db
				.select()
				.from(loopPromotionProposals)
				.where(eq(loopPromotionProposals.id, result.proposalId))
			expect(proposal.status).toBe('pending')
			expect(proposal.fromStatus).toBe('pilot')
			expect(proposal.toStatus).toBe('supervised')
			expect((proposal.payload as { score: number }).score).toBe(55)
			expect((proposal.payload as { threshold: number }).threshold).toBe(50)
		})

		it('is idempotent: a second evaluator call surfaces the existing pending proposal instead of a duplicate', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'pilot',
				metadata: {
					performance_score: 55,
					kill_threshold: 10,
					promotion_mode: 'human_approved',
				},
			})
			const first = await evaluateAfterRun(db, loop.id, actorId)
			expect(first.kind).toBe('proposed')

			const second = await evaluateAfterRun(db, loop.id, actorId)
			expect(second.kind).toBe('proposal_exists')

			const rows = await db
				.select()
				.from(loopPromotionProposals)
				.where(eq(loopPromotionProposals.loopId, loop.id))
			expect(rows.length).toBe(1)
		})

		it('is a no-op for paused loops even when score is high', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'paused',
				metadata: {
					performance_score: 95,
					kill_threshold: 10,
					promotion_mode: 'auto',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result).toEqual({ kind: 'no_change' })

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('paused')
		})

		it('is a no-op at the top of the ladder (live loops cannot promote further)', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'live',
				metadata: {
					performance_score: 100,
					kill_threshold: 10,
					promotion_mode: 'auto',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result).toEqual({ kind: 'no_change' })

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('live')
		})
	})

	describe('evaluateAfterRun — score-driven demotion', () => {
		it('demotes one rung when score falls below kill_threshold', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'supervised',
				metadata: {
					performance_score: 5,
					kill_threshold: 20,
					promotion_mode: 'auto',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result.kind).toBe('demoted')
			if (result.kind !== 'demoted') return
			expect(result.from).toBe('supervised')
			expect(result.to).toBe('pilot')
			expect(result.reason).toBe('score_below_kill_threshold')

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('pilot')

			const demoted = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_demoted')))
			expect(demoted.length).toBe(1)
			const data = demoted[0].data as {
				reason: string
				from_status: string
				to_status: string
				score: number
			}
			expect(data.reason).toBe('score_below_kill_threshold')
			expect(data.from_status).toBe('supervised')
			expect(data.to_status).toBe('pilot')
			expect(data.score).toBe(5)
		})

		it('demotion outranks promotion when both would apply', async () => {
			// A malformed configuration where score is somehow both above the
			// promotion threshold AND below the kill_threshold shouldn't happen
			// in practice, but the ordering rule (demote first) has to be
			// deterministic regardless.
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'pilot',
				metadata: {
					performance_score: 60,
					kill_threshold: 80,
					promotion_mode: 'auto',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result.kind).toBe('demoted')

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('draft')
		})

		it('does not demote below draft', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'draft',
				metadata: {
					performance_score: 0,
					kill_threshold: 50,
					promotion_mode: 'auto',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			expect(result).toEqual({ kind: 'no_change' })

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('draft')
		})
	})

	describe('breachGuardrail', () => {
		it('demotes one rung and emits both guardrail_breached and demoted events', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'live',
				metadata: {
					performance_score: 90,
					kill_threshold: 20,
					promotion_mode: 'auto',
				},
			})
			const result = await breachGuardrail(db, loop.id, actorId, 'unhandled_exception_in_delivery')
			expect(result.kind).toBe('demoted')
			if (result.kind !== 'demoted') return
			expect(result.from).toBe('live')
			expect(result.to).toBe('supervised')

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('supervised')

			const breached = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_guardrail_breached')))
			expect(breached.length).toBe(1)
			expect((breached[0].data as { reason: string }).reason).toBe(
				'unhandled_exception_in_delivery',
			)

			const demoted = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_demoted')))
			expect(demoted.length).toBe(1)
			expect((demoted[0].data as { reason: string }).reason).toBe('guardrail_breach')
		})

		it('fires the breach event even when the loop is at draft (no rung change possible)', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'draft',
			})
			const result = await breachGuardrail(db, loop.id, actorId, 'runtime_type_error')
			expect(result).toEqual({ kind: 'no_change' })

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('draft')

			const breached = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_guardrail_breached')))
			expect(breached.length).toBe(1)

			const demoted = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_demoted')))
			expect(demoted.length).toBe(0)
		})

		it('does not touch paused or archived loops', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'paused',
			})
			const result = await breachGuardrail(db, loop.id, actorId, 'anything')
			expect(result).toEqual({ kind: 'no_change' })

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('paused')

			const breached = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loop.id), eq(events.action, 'loop_guardrail_breached')))
			expect(breached.length).toBe(0)
		})

		it('fires independently of score — a live loop with a perfect score still demotes on breach', async () => {
			const loop = await insertLoop(workspaceId, actorId, {
				status: 'live',
				metadata: {
					performance_score: 100,
					kill_threshold: 0,
					promotion_mode: 'auto',
				},
			})
			const result = await breachGuardrail(db, loop.id, actorId, 'critical_downstream_failure')
			expect(result.kind).toBe('demoted')

			const [row] = await db.select().from(objects).where(eq(objects.id, loop.id))
			expect(row.status).toBe('supervised')
		})
	})

	describe('Human decision routes', () => {
		async function seedPendingProposal(status: 'draft' | 'pilot' | 'supervised' = 'pilot') {
			const loop = await insertLoop(workspaceId, actorId, {
				status,
				metadata: {
					performance_score: 90,
					kill_threshold: 10,
					promotion_mode: 'human_approved',
				},
			})
			const result = await evaluateAfterRun(db, loop.id, actorId)
			if (result.kind !== 'proposed') throw new Error('expected proposed')
			return { loopId: loop.id, proposalId: result.proposalId }
		}

		it('approve advances the loop rung and marks the proposal approved', async () => {
			const { loopId, proposalId } = await seedPendingProposal('pilot')
			const app = makeApp(actorId)
			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/approve`,
					{},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { status: string; decidedBy: string }
			expect(body.status).toBe('approved')
			expect(body.decidedBy).toBe(actorId)

			const [row] = await db.select().from(objects).where(eq(objects.id, loopId))
			expect(row.status).toBe('supervised')

			const approved = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, proposalId), eq(events.action, 'loop_promotion_approved')))
			expect(approved.length).toBe(1)

			const promoted = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loopId), eq(events.action, 'loop_promoted')))
			expect(promoted.length).toBe(1)
			expect((promoted[0].data as { mode: string }).mode).toBe('human_approved')
		})

		it('reject leaves the loop at its current rung and records the reason', async () => {
			const { loopId, proposalId } = await seedPendingProposal('pilot')
			const app = makeApp(actorId)
			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/reject`,
					{ reason: 'Wait until we see two more weeks of clean runs' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { status: string; reason: string }
			expect(body.status).toBe('rejected')
			expect(body.reason).toBe('Wait until we see two more weeks of clean runs')

			const [row] = await db.select().from(objects).where(eq(objects.id, loopId))
			expect(row.status).toBe('pilot')

			const rejected = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, proposalId), eq(events.action, 'loop_promotion_rejected')))
			expect(rejected.length).toBe(1)
		})

		it('defer leaves the loop at its current rung and unblocks a fresh proposal on next eval', async () => {
			const { loopId, proposalId } = await seedPendingProposal('pilot')
			const app = makeApp(actorId)
			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/defer`,
					{ reason: 'Revisit after the retro' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			expect(((await res.json()) as { status: string }).status).toBe('deferred')

			const [row] = await db.select().from(objects).where(eq(objects.id, loopId))
			expect(row.status).toBe('pilot')

			// The partial-unique index only guards pending rows — once deferred,
			// the next eval must be free to enqueue a new proposal.
			const next = await evaluateAfterRun(db, loopId, actorId)
			expect(next.kind).toBe('proposed')
		})

		it('409s when a proposal is already decided', async () => {
			const { proposalId } = await seedPendingProposal('pilot')
			const app = makeApp(actorId)
			const first = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/approve`,
					{},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(first.status).toBe(200)

			const second = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/reject`,
					{ reason: 'oops' },
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(second.status).toBe(409)
		})

		it('404s when a foreign workspace member tries to decide a proposal', async () => {
			const { proposalId } = await seedPendingProposal('pilot')
			const foreignActor = await insertActor(db)
			const app = makeApp(foreignActor.id)
			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/approve`,
					{},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(404)
		})

		it('approve is skipped when the loop moved off from_status between propose and approve', async () => {
			const { loopId, proposalId } = await seedPendingProposal('pilot')
			// Simulate a concurrent guardrail-breach demote landing before the
			// human approves — the proposal was written for pilot → supervised
			// but the loop is now on draft.
			await db
				.update(objects)
				.set({ status: 'draft', updatedAt: new Date() })
				.where(eq(objects.id, loopId))

			const app = makeApp(actorId)
			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/loop-promotions/${proposalId}/approve`,
					{},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { status: string }
			expect(body.status).toBe('approved')

			// Rung change was skipped because the source rung no longer matches.
			const [row] = await db.select().from(objects).where(eq(objects.id, loopId))
			expect(row.status).toBe('draft')

			const promoted = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, loopId), eq(events.action, 'loop_promoted')))
			expect(promoted.length).toBe(0)
		})
	})
})
