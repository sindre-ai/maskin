import { z } from 'zod'

/**
 * Loop lifecycle rung ladder + promotion/demotion decision helpers
 * (T5 of bet/loop-lifecycle-status-ladder). Pure and side-effect-free so the
 * runtime path (`apps/dev/src/services/loop-lifecycle.ts`) and any unit tests
 * share one algorithm.
 *
 * The four rungs `draft → pilot → supervised → live` are ordered. `paused` and
 * `archived` are lifecycle stops that exist outside the ladder: neither
 * promotion nor demotion moves them — a paused/archived loop stays put until a
 * human resumes it. T4 owns the runtime meaning of each rung (what side
 * effects execute at each step); this module owns only the transitions
 * between rungs.
 */

export const LOOP_RUNGS = ['draft', 'pilot', 'supervised', 'live'] as const
export type LoopRung = (typeof LOOP_RUNGS)[number]

export const loopRungSchema = z.enum(LOOP_RUNGS)

export const LOOP_NON_RUNG_STATUSES = ['paused', 'archived'] as const
export type LoopNonRungStatus = (typeof LOOP_NON_RUNG_STATUSES)[number]

export const loopLifecycleStatusSchema = z.enum([...LOOP_RUNGS, ...LOOP_NON_RUNG_STATUSES])
export type LoopLifecycleStatus = z.infer<typeof loopLifecycleStatusSchema>

export const loopPromotionModeSchema = z.enum(['auto', 'human_approved'])
export type LoopPromotionMode = z.infer<typeof loopPromotionModeSchema>

/**
 * Score required to graduate off each rung. Constants rather than per-loop
 * config so the ladder itself is legible in one place; a loop's own tuning
 * knob is `kill_threshold` (per-loop, defined by the operator) and
 * `outcome_target` (per-loop, defined by the operator). No entry for `live` —
 * `live` is the top of the ladder, there is nowhere to promote to.
 */
export const LOOP_PROMOTION_THRESHOLDS: Record<Exclude<LoopRung, 'live'>, number> = {
	draft: 20,
	pilot: 50,
	supervised: 70,
}

export function isLoopRung(status: string): status is LoopRung {
	return (LOOP_RUNGS as readonly string[]).includes(status)
}

export function nextRung(current: LoopRung): LoopRung | null {
	const idx = LOOP_RUNGS.indexOf(current)
	if (idx < 0 || idx === LOOP_RUNGS.length - 1) return null
	return LOOP_RUNGS[idx + 1] ?? null
}

export function previousRung(current: LoopRung): LoopRung | null {
	const idx = LOOP_RUNGS.indexOf(current)
	if (idx <= 0) return null
	return LOOP_RUNGS[idx - 1] ?? null
}

export type PromotionDecision =
	| { kind: 'auto_promote'; from: LoopRung; to: LoopRung }
	| { kind: 'propose_promotion'; from: LoopRung; to: LoopRung }
	| { kind: 'no_change' }

/**
 * Given a loop's current rung and observed score, decide whether the driver
 * should propose or auto-apply a promotion. Non-rung statuses (paused,
 * archived) and the top of the ladder (live) always return `no_change`.
 */
export function evaluatePromotion(
	rung: LoopLifecycleStatus,
	score: number | null | undefined,
	mode: LoopPromotionMode,
): PromotionDecision {
	if (!isLoopRung(rung)) return { kind: 'no_change' }
	const to = nextRung(rung)
	if (!to) return { kind: 'no_change' }
	if (score === null || score === undefined) return { kind: 'no_change' }
	const threshold = LOOP_PROMOTION_THRESHOLDS[rung as Exclude<LoopRung, 'live'>]
	if (score < threshold) return { kind: 'no_change' }
	return mode === 'auto'
		? { kind: 'auto_promote', from: rung, to }
		: { kind: 'propose_promotion', from: rung, to }
}

export type DemotionDecision =
	| { kind: 'demote'; from: LoopRung; to: LoopRung }
	| { kind: 'no_change' }

/**
 * Score-driven demotion — automatic, no approval needed. Only fires when a
 * kill threshold is present and the observed score is below it. `draft`
 * cannot be demoted further (there is no rung below); it returns `no_change`
 * rather than an error so the caller can loop over every loop without
 * branching on status. Non-rung statuses are also no-ops.
 */
export function evaluateDemotion(
	rung: LoopLifecycleStatus,
	score: number | null | undefined,
	killThreshold: number | null | undefined,
): DemotionDecision {
	if (!isLoopRung(rung)) return { kind: 'no_change' }
	if (score === null || score === undefined) return { kind: 'no_change' }
	if (killThreshold === null || killThreshold === undefined) return { kind: 'no_change' }
	if (score >= killThreshold) return { kind: 'no_change' }
	const to = previousRung(rung)
	if (!to) return { kind: 'no_change' }
	return { kind: 'demote', from: rung, to }
}

/**
 * Guardrail-breach demotion — independent of score. A single hard failure
 * always demotes one rung, so this returns the demotion decision whenever the
 * loop is on the ladder and above `draft`. Callers combine this with the
 * failure reason and route the resulting `loop_guardrail_breached` event.
 */
export function evaluateGuardrailBreach(rung: LoopLifecycleStatus): DemotionDecision {
	if (!isLoopRung(rung)) return { kind: 'no_change' }
	const to = previousRung(rung)
	if (!to) return { kind: 'no_change' }
	return { kind: 'demote', from: rung, to }
}
