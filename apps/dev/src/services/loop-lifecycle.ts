import type { Database } from '@maskin/db'
import { events, loopPromotionProposals, objects } from '@maskin/db/schema'
import {
	LOOP_PROMOTION_THRESHOLDS,
	type LoopLifecycleStatus,
	type LoopPromotionMode,
	type LoopRung,
	evaluateDemotion,
	evaluateGuardrailBreach,
	evaluatePromotion,
	isLoopRung,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'

/**
 * Loop lifecycle service — the runtime glue for T5 of
 * bet/loop-lifecycle-status-ladder.
 *
 * Every rung transition is centralised here so the algorithm (pure helpers in
 * `packages/shared/src/schemas/loop-lifecycle.ts`) has exactly one DB
 * consumer. Two entry points:
 *   - `evaluateAfterRun` — called from the run-completion path once T3's
 *     score is present. Handles score-driven promotion (auto or proposed)
 *     and score-driven demotion in a single pass.
 *   - `breachGuardrail` — called from the run-error path on a single hard
 *     failure. Independent of score; always attempts to drop one rung.
 *
 * Both entry points read the loop's status + tuning knobs off `objects` and
 * `objects.metadata` (T2 and T3 will lift these to top-level columns, at
 * which point the two `readLoopState` reads switch fields without any
 * caller-visible change).
 *
 * Approve / reject / defer of the proposals this service emits is owned by
 * `apps/dev/src/routes/loop-promotions.ts` — this file writes them.
 */

const LOOP_TYPE = 'loop'

type LoopState = {
	id: string
	workspaceId: string
	status: LoopLifecycleStatus
	score: number | null
	killThreshold: number | null
	promotionMode: LoopPromotionMode
}

async function readLoopState(db: Database, loopId: string): Promise<LoopState | null> {
	const [row] = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			status: objects.status,
			metadata: objects.metadata,
			type: objects.type,
		})
		.from(objects)
		.where(eq(objects.id, loopId))
		.limit(1)
	if (!row || row.type !== LOOP_TYPE) return null
	const metadata = (row.metadata ?? {}) as Record<string, unknown>
	const rawScore = metadata.performance_score
	const rawKill = metadata.kill_threshold
	const rawMode = metadata.promotion_mode
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		status: row.status as LoopLifecycleStatus,
		score: typeof rawScore === 'number' ? rawScore : null,
		killThreshold: typeof rawKill === 'number' ? rawKill : null,
		promotionMode: rawMode === 'auto' ? 'auto' : 'human_approved',
	}
}

export type EvaluateAfterRunResult =
	| { kind: 'no_change' }
	| { kind: 'promoted'; from: LoopRung; to: LoopRung; mode: 'auto' }
	| { kind: 'proposed'; from: LoopRung; to: LoopRung; proposalId: string }
	| { kind: 'proposal_exists'; proposalId: string }
	| { kind: 'demoted'; from: LoopRung; to: LoopRung; reason: 'score_below_kill_threshold' }

/**
 * Called after a run completes. Evaluates demotion FIRST (a score below the
 * kill threshold outranks any promotion proposal — you don't propose to
 * promote a loop that just tripped its floor), then evaluates promotion.
 * Non-rung statuses (`paused`, `archived`) short-circuit before either.
 */
export async function evaluateAfterRun(
	db: Database,
	loopId: string,
	actorId: string,
): Promise<EvaluateAfterRunResult> {
	const state = await readLoopState(db, loopId)
	if (!state || !isLoopRung(state.status)) return { kind: 'no_change' }

	const demotion = evaluateDemotion(state.status, state.score, state.killThreshold)
	if (demotion.kind === 'demote') {
		await applyRungChange(db, state, demotion.to, actorId, {
			action: 'loop_demoted',
			reason: 'score_below_kill_threshold',
			score: state.score,
			killThreshold: state.killThreshold,
		})
		return {
			kind: 'demoted',
			from: demotion.from,
			to: demotion.to,
			reason: 'score_below_kill_threshold',
		}
	}

	const promotion = evaluatePromotion(state.status, state.score, state.promotionMode)
	if (promotion.kind === 'no_change') return { kind: 'no_change' }

	if (promotion.kind === 'auto_promote') {
		await applyRungChange(db, state, promotion.to, actorId, {
			action: 'loop_promoted',
			mode: 'auto',
			score: state.score,
			threshold: LOOP_PROMOTION_THRESHOLDS[promotion.from as Exclude<LoopRung, 'live'>],
		})
		return { kind: 'promoted', from: promotion.from, to: promotion.to, mode: 'auto' }
	}

	// human_approved — enqueue a pending proposal. Partial UNIQUE on
	// (loop_id) WHERE status = 'pending' means concurrent evaluators can't
	// stack duplicate rows; if the insert loses the race, we surface the
	// already-open proposal id instead of an error.
	const threshold = LOOP_PROMOTION_THRESHOLDS[promotion.from as Exclude<LoopRung, 'live'>]
	const payload = {
		score: state.score,
		threshold,
		mode: state.promotionMode,
	}
	try {
		const [created] = await db
			.insert(loopPromotionProposals)
			.values({
				workspaceId: state.workspaceId,
				loopId: state.id,
				fromStatus: promotion.from,
				toStatus: promotion.to,
				payload,
				proposedBy: actorId,
			})
			.returning()
		if (!created) return { kind: 'no_change' }
		await db.insert(events).values({
			workspaceId: state.workspaceId,
			actorId,
			action: 'loop_promotion_proposed',
			entityType: 'loop_promotion_proposal',
			entityId: created.id,
			data: {
				loop_id: state.id,
				from_status: promotion.from,
				to_status: promotion.to,
				score: state.score,
				threshold,
			},
		})
		return { kind: 'proposed', from: promotion.from, to: promotion.to, proposalId: created.id }
	} catch (err: unknown) {
		// Drizzle wraps postgres errors — the PG SQLSTATE ('23505' = unique
		// violation) is on `.cause.code` for the outer DrizzleError and on
		// `.code` when the driver throws directly. Check both.
		const code =
			(err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
		if (code === '23505') {
			const [existing] = await db
				.select({ id: loopPromotionProposals.id })
				.from(loopPromotionProposals)
				.where(
					and(
						eq(loopPromotionProposals.loopId, state.id),
						eq(loopPromotionProposals.status, 'pending'),
					),
				)
				.limit(1)
			if (existing) return { kind: 'proposal_exists', proposalId: existing.id }
		}
		throw err
	}
}

export type BreachGuardrailResult =
	| { kind: 'no_change' }
	| { kind: 'demoted'; from: LoopRung; to: LoopRung }

/**
 * Called on a single hard failure that trips a guardrail. Demotes one rung
 * regardless of the score (the whole point of the guardrail path is that
 * some failure classes must not wait for the score to catch up). `draft` is
 * the floor — a guardrail breach at `draft` emits the breach event but
 * doesn't delete the loop.
 */
export async function breachGuardrail(
	db: Database,
	loopId: string,
	actorId: string,
	reason: string,
): Promise<BreachGuardrailResult> {
	const state = await readLoopState(db, loopId)
	if (!state || !isLoopRung(state.status)) return { kind: 'no_change' }

	// Always record the breach itself — this is the training signal, whether
	// or not we can actually demote.
	await db.insert(events).values({
		workspaceId: state.workspaceId,
		actorId,
		action: 'loop_guardrail_breached',
		entityType: 'object',
		entityId: state.id,
		data: {
			loop_id: state.id,
			status: state.status,
			reason,
		},
	})

	const decision = evaluateGuardrailBreach(state.status)
	if (decision.kind === 'no_change') return { kind: 'no_change' }

	await applyRungChange(db, state, decision.to, actorId, {
		action: 'loop_demoted',
		reason: 'guardrail_breach',
		guardrail_reason: reason,
	})
	return { kind: 'demoted', from: decision.from, to: decision.to }
}

/**
 * Approve a pending proposal: advance the loop rung and mark the row
 * `approved`. Returns the applied change or `null` when the proposal isn't
 * pending (the caller — a route handler — turns that into a 404 or 409).
 */
export async function approvePromotionProposal(
	db: Database,
	proposalId: string,
	actorId: string,
): Promise<{ from: LoopRung; to: LoopRung; loopId: string } | { conflict: true } | null> {
	const [proposal] = await db
		.select()
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, proposalId))
		.limit(1)
	if (!proposal) return null
	if (proposal.status !== 'pending') return { conflict: true }

	const now = new Date()
	const [updated] = await db
		.update(loopPromotionProposals)
		.set({
			status: 'approved',
			decidedBy: actorId,
			decidedAt: now,
			updatedAt: now,
		})
		.where(
			and(eq(loopPromotionProposals.id, proposalId), eq(loopPromotionProposals.status, 'pending')),
		)
		.returning()
	if (!updated) return { conflict: true }

	const state = await readLoopState(db, proposal.loopId)
	// Re-check the loop is still on a rung and still at the source rung the
	// proposal was written against — a concurrent demotion or a paused loop
	// invalidates the approve. Ship the proposal-decided event either way
	// (the human's decision is real), but skip the rung change.
	if (state && isLoopRung(state.status) && state.status === proposal.fromStatus) {
		await applyRungChange(db, state, proposal.toStatus as LoopRung, actorId, {
			action: 'loop_promoted',
			mode: 'human_approved',
			proposal_id: proposalId,
		})
	}

	await db.insert(events).values({
		workspaceId: updated.workspaceId,
		actorId,
		action: 'loop_promotion_approved',
		entityType: 'loop_promotion_proposal',
		entityId: updated.id,
		data: {
			loop_id: updated.loopId,
			from_status: updated.fromStatus,
			to_status: updated.toStatus,
		},
	})

	return {
		from: proposal.fromStatus as LoopRung,
		to: proposal.toStatus as LoopRung,
		loopId: proposal.loopId,
	}
}

/** Reject a pending proposal — leave the rung, capture the reason. */
export async function rejectPromotionProposal(
	db: Database,
	proposalId: string,
	actorId: string,
	reason: string | null,
): Promise<{ loopId: string } | { conflict: true } | null> {
	return decidePromotionProposal(db, proposalId, actorId, 'rejected', reason)
}

/** Defer a pending proposal — leave the rung; next evaluator can create a fresh row. */
export async function deferPromotionProposal(
	db: Database,
	proposalId: string,
	actorId: string,
	reason: string | null,
): Promise<{ loopId: string } | { conflict: true } | null> {
	return decidePromotionProposal(db, proposalId, actorId, 'deferred', reason)
}

async function decidePromotionProposal(
	db: Database,
	proposalId: string,
	actorId: string,
	nextStatus: 'rejected' | 'deferred',
	reason: string | null,
): Promise<{ loopId: string } | { conflict: true } | null> {
	const [row] = await db
		.select()
		.from(loopPromotionProposals)
		.where(eq(loopPromotionProposals.id, proposalId))
		.limit(1)
	if (!row) return null
	if (row.status !== 'pending') return { conflict: true }

	const now = new Date()
	const [updated] = await db
		.update(loopPromotionProposals)
		.set({
			status: nextStatus,
			reason,
			decidedBy: actorId,
			decidedAt: now,
			updatedAt: now,
		})
		.where(
			and(eq(loopPromotionProposals.id, proposalId), eq(loopPromotionProposals.status, 'pending')),
		)
		.returning()
	if (!updated) return { conflict: true }

	await db.insert(events).values({
		workspaceId: updated.workspaceId,
		actorId,
		action: nextStatus === 'rejected' ? 'loop_promotion_rejected' : 'loop_promotion_deferred',
		entityType: 'loop_promotion_proposal',
		entityId: updated.id,
		data: {
			loop_id: updated.loopId,
			from_status: updated.fromStatus,
			to_status: updated.toStatus,
			reason,
		},
	})
	return { loopId: updated.loopId }
}

type RungChangeAudit = {
	action: 'loop_promoted' | 'loop_demoted'
	// biome-ignore lint/suspicious/noExplicitAny: audit blob is deliberately open — every caller adds a different subset of fields.
	[k: string]: any
}

async function applyRungChange(
	db: Database,
	state: LoopState,
	toStatus: LoopRung,
	actorId: string,
	audit: RungChangeAudit,
) {
	const now = new Date()
	// Guard the write against a stale read (another mutation changed the loop
	// between readLoopState and this point). The compare-and-set means a
	// concurrent demotion or a status change to paused/archived leaves the
	// caller's audit event out — which is correct: the caller's decision was
	// invalidated by the state change.
	const result = await db
		.update(objects)
		.set({ status: toStatus, updatedAt: now })
		.where(and(eq(objects.id, state.id), eq(objects.status, state.status)))
		.returning({ id: objects.id })
	if (result.length === 0) return

	await db.insert(events).values({
		workspaceId: state.workspaceId,
		actorId,
		action: audit.action,
		entityType: 'object',
		entityId: state.id,
		data: {
			loop_id: state.id,
			from_status: state.status,
			to_status: toStatus,
			...audit,
		},
	})
}
