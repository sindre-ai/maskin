import type { Database } from '@maskin/db'
import { objects, relationships, sessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Loop performance score engine (T3 of bet/loop-lifecycle-status-ladder).
 *
 * A loop's score is a continuous 0–100 signal — a mirror of the two-value
 * `evidence_quality` field on bets, but graded rather than binary — that
 * drives the promotion/demotion decisions in
 * `apps/dev/src/services/loop-lifecycle.ts::evaluateAfterRun`. It is
 * recomputed and rewritten in place on every run completion by
 * `recomputeAndPersistScore`, called from the two session-completion sites
 * in `session-manager.ts`.
 *
 * Two components:
 *   - PRIMARY, outcome completion rate. For every object linked to the loop
 *     via an `in_loop` edge, does its `status` equal the loop's
 *     `outcome_metric`? A loop with `outcome_metric = 'meeting_booked'`
 *     scores the fraction of members currently at that status. This is the
 *     signal the bet spec names as primary because it measures the end state
 *     the loop was configured to produce, not just runtime hygiene.
 *   - SECONDARY, run reliability. For every session launched from any of the
 *     loop's `metadata.trigger_ids`, does it end in `completed`? Failures
 *     and timeouts count against, in-flight sessions don't count either way.
 *     This catches loops that run cleanly but never move the primary — the
 *     bare minimum ops signal.
 *
 * Evidence-bounding: the raw weighted-average is multiplied by
 *   min(1, (member_count + terminal_run_count) / MIN_EVIDENCE_OBSERVATIONS)
 * so a loop with only a handful of observations cannot climb high enough to
 * trip a promotion threshold no matter how favorable its rates. Four clean
 * runs (evidence = 4, factor = 0.2) hard-cap a 100 % raw score at 20 —
 * comfortably below every rung threshold in
 * `LOOP_PROMOTION_THRESHOLDS`.
 */

const LOOP_TYPE = 'loop'
const PRIMARY_WEIGHT = 0.7
const SECONDARY_WEIGHT = 0.3
/**
 * Sample count at which the evidence factor reaches 1.0. Deliberately set
 * above every rung threshold (`pilot = 50`, `supervised = 70`) so a loop
 * cannot climb into `supervised` on a handful of samples — matching the
 * bet's "a loop with four clean runs cannot score high" invariant.
 */
export const MIN_EVIDENCE_OBSERVATIONS = 20

/** Terminal session statuses that count toward the reliability denominator. */
const TERMINAL_SESSION_STATUSES = ['completed', 'failed', 'timeout'] as const
type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number]

export type LoopScoreBreakdown = {
	/** Rounded 0–100 score persisted to `objects.performance_score`. */
	score: number
	/** Raw pre-evidence-cap blend of primary + secondary, 0–100. */
	rawScore: number
	/** min(1, evidence / MIN_EVIDENCE_OBSERVATIONS). */
	evidenceFactor: number
	outcome: {
		/** null when the loop has no in_loop members yet. */
		rate: number | null
		reached: number
		total: number
	}
	reliability: {
		/** null when the loop has no terminal-state sessions from its triggers. */
		rate: number | null
		clean: number
		total: number
	}
	/** members + terminal_runs; input to the evidence factor. */
	evidence: number
}

/**
 * Read the loop's outcome_metric + trigger_ids off the row and compute the
 * component rates. Returns null for a non-loop id or a loop with
 * outcome_metric unset (a loop without a defined end-state cannot be scored
 * yet — computing zero would be indistinguishable from "score is zero" and
 * would trigger a spurious kill-threshold demotion).
 */
export async function computeLoopPerformanceScore(
	db: Database,
	loopId: string,
): Promise<LoopScoreBreakdown | null> {
	const [loop] = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			type: objects.type,
			outcomeMetric: objects.outcomeMetric,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(eq(objects.id, loopId))
		.limit(1)
	if (!loop || loop.type !== LOOP_TYPE) return null
	if (!loop.outcomeMetric) return null

	const triggerIds = extractTriggerIds(loop.metadata)

	const [outcome, reliability] = await Promise.all([
		measureOutcome(db, loop.id, loop.workspaceId, loop.outcomeMetric),
		measureReliability(db, loop.workspaceId, triggerIds),
	])

	const components: Array<{ rate: number; weight: number }> = []
	if (outcome.rate !== null) components.push({ rate: outcome.rate, weight: PRIMARY_WEIGHT })
	if (reliability.rate !== null)
		components.push({ rate: reliability.rate, weight: SECONDARY_WEIGHT })

	const rawScore =
		components.length === 0
			? 0
			: (100 * components.reduce((acc, c) => acc + c.rate * c.weight, 0)) /
				components.reduce((acc, c) => acc + c.weight, 0)

	const evidence = outcome.total + reliability.total
	const evidenceFactor = Math.min(1, evidence / MIN_EVIDENCE_OBSERVATIONS)
	// Round to two decimals so the persisted value is human-legible on the
	// loop card without losing signal near the threshold boundaries.
	const score = Math.round(rawScore * evidenceFactor * 100) / 100

	return {
		score,
		rawScore: Math.round(rawScore * 100) / 100,
		evidenceFactor,
		outcome,
		reliability,
		evidence,
	}
}

/**
 * Recompute the score and persist it to `objects.performance_score` for the
 * given loop. Returns the breakdown when a write happened, or `null` when
 * the loop can't be scored (non-loop id, missing outcome_metric). Persists
 * even a score that hasn't changed — the row's `updated_at` is bumped so
 * SSE consumers can key on the change signal.
 */
export async function recomputeAndPersistScore(
	db: Database,
	loopId: string,
): Promise<LoopScoreBreakdown | null> {
	const breakdown = await computeLoopPerformanceScore(db, loopId)
	if (!breakdown) return null
	await db
		.update(objects)
		.set({
			performanceScore: breakdown.score.toString(),
			updatedAt: new Date(),
		})
		.where(eq(objects.id, loopId))
	return breakdown
}

async function measureOutcome(
	db: Database,
	loopId: string,
	workspaceId: string,
	outcomeMetric: string,
): Promise<{ rate: number | null; reached: number; total: number }> {
	// `in_loop` edges have `source_id = loop, target_id = member`. Scoped to
	// the loop's own workspace so a leaked target_id in the edges cannot pull
	// counts from another workspace.
	const [row] = await db
		.select({
			reached: sql<number>`COUNT(*) FILTER (WHERE ${objects.status} = ${outcomeMetric})::int`,
			total: sql<number>`COUNT(*)::int`,
		})
		.from(relationships)
		.innerJoin(objects, eq(objects.id, relationships.targetId))
		.where(
			and(
				eq(relationships.sourceId, loopId),
				eq(relationships.type, 'in_loop'),
				eq(objects.workspaceId, workspaceId),
			),
		)
	const reached = Number(row?.reached ?? 0)
	const total = Number(row?.total ?? 0)
	return {
		rate: total > 0 ? reached / total : null,
		reached,
		total,
	}
}

async function measureReliability(
	db: Database,
	workspaceId: string,
	triggerIds: string[],
): Promise<{ rate: number | null; clean: number; total: number }> {
	if (triggerIds.length === 0) return { rate: null, clean: 0, total: 0 }
	const [row] = await db
		.select({
			clean: sql<number>`COUNT(*) FILTER (WHERE ${sessions.status} = 'completed')::int`,
			total: sql<number>`COUNT(*)::int`,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				inArray(sessions.triggerId, triggerIds),
				inArray(sessions.status, [...TERMINAL_SESSION_STATUSES]),
			),
		)
	const clean = Number(row?.clean ?? 0)
	const total = Number(row?.total ?? 0)
	return {
		rate: total > 0 ? clean / total : null,
		clean,
		total,
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function extractTriggerIds(metadata: unknown): string[] {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
	const raw = (metadata as Record<string, unknown>).trigger_ids
	if (!Array.isArray(raw)) return []
	return raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
}

/**
 * Resolve a session's completing trigger to the loop that owns it, if any.
 * A loop's membership in a session is expressed by
 * `objects.metadata.trigger_ids` containing the session's `trigger_id` —
 * that's what the read API (`apps/dev/src/routes/loops.ts`) uses to walk
 * from loop to sessions, and this walks in the opposite direction. Returns
 * `null` when no loop claims the trigger, or when the session has no
 * trigger id (an ad-hoc `POST /sessions`).
 */
export async function findLoopForSessionTrigger(
	db: Database,
	workspaceId: string,
	triggerId: string | null,
): Promise<string | null> {
	if (!triggerId) return null
	// `metadata->'trigger_ids' ? triggerId` uses the jsonb-contains-key
	// operator against the trigger_ids array. Loops per workspace stay in
	// the tens; a filtered scan on (workspaceId, type='loop') is cheap
	// enough that no dedicated index is warranted.
	const [row] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, LOOP_TYPE),
				sql`${objects.metadata}->'trigger_ids' ? ${triggerId}`,
			),
		)
		.limit(1)
	return row?.id ?? null
}

// A `TerminalSessionStatus` re-export keeps callers on the same enum without
// pulling `session-manager`'s TERMINAL_OR_TRANSITIONAL set (which mixes in
// transitional states this module deliberately excludes from the denominator).
export type { TerminalSessionStatus }
