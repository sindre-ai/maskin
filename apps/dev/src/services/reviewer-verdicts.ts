import type { Database } from '@maskin/db'
import { events, actors, objects, reviewerVerdicts } from '@maskin/db/schema'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { logger } from '../lib/logger'

// Persistence + rating + precision for T6's Stage 2 reviewer verdicts.
// See bet: Single-prompt agent builder — AC 6 requires reviewer precision
// ≥70% before Stage 2 ships; DoD 5 requires the failing-precision comment
// to name the specific rubric criteria driving false positives.

export const PRECISION_THRESHOLD = 0.7

export type ReviewerCriterionVerdict = {
	name: string
	pass: boolean
	fix?: string | null
}

export class ReviewerVerdictError extends Error {
	constructor(
		readonly code:
			| 'rubric_not_found'
			| 'target_actor_not_found'
			| 'verdict_not_found'
			| 'already_rated'
			| 'self_rating_forbidden',
		message: string,
	) {
		super(message)
		this.name = 'ReviewerVerdictError'
	}
}

export interface RecordVerdictInput {
	db: Database
	workspaceId: string
	rubricId: string
	targetActorId: string
	reviewerActorId: string
	reviewerSessionId?: string | null
	cycleNumber?: number
	verdict: 'pass' | 'fail'
	criteriaVerdicts: ReviewerCriterionVerdict[]
	createdBy: string
}

export interface RateVerdictInput {
	db: Database
	workspaceId: string
	verdictId: string
	ratedByActorId: string
	humanAgreed: boolean
	criteriaDisagreements?: string[]
	note?: string
}

export interface PrecisionSummary {
	rubric_id: string
	precision_threshold: number
	total_verdicts: number
	rated_verdicts: number
	agreed_verdicts: number
	precision: number | null
	meets_threshold: boolean
	failing_criteria: Array<{
		name: string
		false_positive_count: number
	}>
	summary_line: string
}

/**
 * Persist one reviewer verdict. Called by T6's reviewer path (or by tests /
 * the MCP tool) right after `maskin_review_work` produces a verdict. Also
 * fires the `reviewer_verdict_submitted` PostHog event so the ship-metric
 * pipeline (`posthog_query` on the bet: `reviewer_verdict_submitted`) sees
 * the same row that lands in `reviewer_verdicts`.
 */
export async function recordReviewerVerdict(input: RecordVerdictInput): Promise<{ id: string }> {
	const {
		db,
		workspaceId,
		rubricId,
		targetActorId,
		reviewerActorId,
		reviewerSessionId,
		cycleNumber,
		verdict,
		criteriaVerdicts,
		createdBy,
	} = input

	const [rubric] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(and(eq(objects.id, rubricId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!rubric) {
		throw new ReviewerVerdictError(
			'rubric_not_found',
			`Rubric ${rubricId} not found in workspace ${workspaceId}`,
		)
	}

	const [target] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(eq(actors.id, targetActorId))
		.limit(1)
	if (!target) {
		throw new ReviewerVerdictError(
			'target_actor_not_found',
			`Target actor ${targetActorId} not found`,
		)
	}

	const inserted = await db
		.insert(reviewerVerdicts)
		.values({
			workspaceId,
			rubricId,
			targetActorId,
			reviewerActorId,
			reviewerSessionId: reviewerSessionId ?? null,
			cycleNumber: cycleNumber ?? 0,
			verdict,
			criteriaVerdicts,
			createdBy,
		})
		.returning()
	const row = inserted[0]
	if (!row) {
		throw new Error('reviewer_verdicts insert returned no row')
	}

	await db.insert(events).values({
		workspaceId,
		actorId: createdBy,
		action: 'created',
		entityType: 'reviewer_verdict',
		entityId: row.id,
		data: {
			verdict,
			cycle_number: row.cycleNumber,
			rubric_id: rubricId,
			target_actor_id: targetActorId,
			reviewer_session_id: reviewerSessionId ?? null,
			criteria_verdicts: criteriaVerdicts,
		},
	})

	// Ship-metric emit named by the bet: reviewer_verdict_submitted. Distinct
	// id is the workspace so multiple reviews on the same workspace group in
	// PostHog; verdict-level properties keep the row inspectable there.
	void capturePosthogEvent('reviewer_verdict_submitted', workspaceId, {
		verdict_id: row.id,
		rubric_id: rubricId,
		actor_id: targetActorId,
		overall: verdict,
		cycle_number: row.cycleNumber,
		reviewer_session_id: reviewerSessionId ?? null,
	})

	return { id: row.id }
}

/**
 * Set `human_agreed` (and optional per-criterion disagreements + note) on
 * an existing verdict. Rejects self-rating: the caller actor cannot be the
 * reviewer that produced the verdict — the reviewer must NOT auto-populate
 * its own rating, per bet constraint. Idempotent-hostile on purpose: a
 * second call throws `already_rated` so a double-rate can't overwrite a
 * human's original judgment silently.
 */
export async function rateReviewerVerdict(input: RateVerdictInput): Promise<{
	id: string
	humanAgreed: boolean
	humanCriteriaDisagreements: string[] | null
}> {
	const { db, workspaceId, verdictId, ratedByActorId, humanAgreed, criteriaDisagreements, note } =
		input

	const [existing] = await db
		.select()
		.from(reviewerVerdicts)
		.where(and(eq(reviewerVerdicts.id, verdictId), eq(reviewerVerdicts.workspaceId, workspaceId)))
		.limit(1)
	if (!existing) {
		throw new ReviewerVerdictError(
			'verdict_not_found',
			`Reviewer verdict ${verdictId} not found in workspace ${workspaceId}`,
		)
	}
	if (existing.humanAgreed !== null) {
		throw new ReviewerVerdictError(
			'already_rated',
			`Reviewer verdict ${verdictId} already rated — refusing to overwrite`,
		)
	}
	if (existing.reviewerActorId === ratedByActorId) {
		throw new ReviewerVerdictError(
			'self_rating_forbidden',
			'Reviewer cannot rate its own verdict — human or non-reviewer agent required',
		)
	}

	const now = new Date()
	const updatedRows = await db
		.update(reviewerVerdicts)
		.set({
			humanAgreed,
			humanCriteriaDisagreements: criteriaDisagreements ?? null,
			humanRatedBy: ratedByActorId,
			humanRatedAt: now,
			humanNote: note ?? null,
			updatedAt: now,
		})
		.where(eq(reviewerVerdicts.id, verdictId))
		.returning()
	const updated = updatedRows[0]
	if (!updated) {
		throw new ReviewerVerdictError(
			'verdict_not_found',
			`Reviewer verdict ${verdictId} disappeared before update completed`,
		)
	}

	await db.insert(events).values({
		workspaceId,
		actorId: ratedByActorId,
		action: 'updated',
		entityType: 'reviewer_verdict',
		entityId: verdictId,
		data: {
			human_agreed: humanAgreed,
			human_criteria_disagreements: criteriaDisagreements ?? null,
			note: note ?? null,
		},
	})

	void capturePosthogEvent('reviewer_verdict_rated', workspaceId, {
		verdict_id: verdictId,
		rubric_id: existing.rubricId,
		actor_id: existing.targetActorId,
		human_agreed: humanAgreed,
		disagreement_count: criteriaDisagreements?.length ?? 0,
	})

	return {
		id: updated.id,
		humanAgreed: updated.humanAgreed as boolean,
		humanCriteriaDisagreements: (updated.humanCriteriaDisagreements as string[] | null) ?? null,
	}
}

/**
 * Compute precision (agreed / rated) for a rubric and roll up per-criterion
 * false positives so DoD 5's failing-criteria comment can be produced
 * directly from this response.
 *
 * A criterion counts as a "false positive" when either:
 *   - the reviewer marked the criterion `pass: true` AND the human flagged
 *     the criterion by name in `human_criteria_disagreements`, or
 *   - the reviewer's `verdict` was `pass` AND the human disagreed overall
 *     AND named the criterion in `human_criteria_disagreements`.
 * Both paths use the same test: was the criterion in the human's flagged
 * disagreement list? That keeps the definition simple and matches how a
 * human is likely to fill in the field.
 */
export async function computeReviewerPrecision(params: {
	db: Database
	workspaceId: string
	rubricId: string
}): Promise<PrecisionSummary> {
	const { db, workspaceId, rubricId } = params

	const rated = await db
		.select({
			verdict: reviewerVerdicts.verdict,
			humanAgreed: reviewerVerdicts.humanAgreed,
			humanCriteriaDisagreements: reviewerVerdicts.humanCriteriaDisagreements,
			criteriaVerdicts: reviewerVerdicts.criteriaVerdicts,
		})
		.from(reviewerVerdicts)
		.where(
			and(
				eq(reviewerVerdicts.workspaceId, workspaceId),
				eq(reviewerVerdicts.rubricId, rubricId),
				isNotNull(reviewerVerdicts.humanAgreed),
			),
		)
		.orderBy(desc(reviewerVerdicts.createdAt))

	const [{ count: totalCount = 0 } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(reviewerVerdicts)
		.where(
			and(eq(reviewerVerdicts.workspaceId, workspaceId), eq(reviewerVerdicts.rubricId, rubricId)),
		)

	const ratedCount = rated.length
	const agreedCount = rated.filter((r) => r.humanAgreed === true).length
	const precision = ratedCount > 0 ? agreedCount / ratedCount : null

	const falsePositiveByCriterion = new Map<string, number>()
	for (const row of rated) {
		if (row.humanAgreed !== false) continue
		const names = Array.isArray(row.humanCriteriaDisagreements)
			? (row.humanCriteriaDisagreements as string[])
			: []
		for (const name of names) {
			if (typeof name !== 'string' || !name.length) continue
			falsePositiveByCriterion.set(name, (falsePositiveByCriterion.get(name) ?? 0) + 1)
		}
	}
	const failingCriteria = [...falsePositiveByCriterion.entries()]
		.map(([name, count]) => ({ name, false_positive_count: count }))
		.sort((a, b) => b.false_positive_count - a.false_positive_count)

	const meetsThreshold = precision !== null && precision >= PRECISION_THRESHOLD

	const summaryLine =
		precision === null
			? `Reviewer precision: no rated verdicts yet for rubric ${rubricId} (${totalCount} total unrated).`
			: meetsThreshold
				? `Reviewer precision ${(precision * 100).toFixed(1)}% (${agreedCount}/${ratedCount}) — meets ≥${PRECISION_THRESHOLD * 100}% gate.`
				: `Reviewer precision ${(precision * 100).toFixed(1)}% (${agreedCount}/${ratedCount}) — BELOW ≥${PRECISION_THRESHOLD * 100}% gate. Failing criteria: ${
						failingCriteria.length
							? failingCriteria.map((c) => `${c.name} (×${c.false_positive_count})`).join(', ')
							: 'no per-criterion disagreements recorded — collect criterion names from human raters'
					}.`

	logger.debug('reviewer-verdicts: precision computed', {
		workspaceId,
		rubricId,
		totalCount,
		ratedCount,
		agreedCount,
		precision,
	})

	return {
		rubric_id: rubricId,
		precision_threshold: PRECISION_THRESHOLD,
		total_verdicts: Number(totalCount),
		rated_verdicts: ratedCount,
		agreed_verdicts: agreedCount,
		precision,
		meets_threshold: meetsThreshold,
		failing_criteria: failingCriteria,
		summary_line: summaryLine,
	}
}
