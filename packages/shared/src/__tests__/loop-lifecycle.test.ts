import { describe, expect, it } from 'vitest'
import {
	LOOP_PROMOTION_THRESHOLDS,
	LOOP_RUNGS,
	evaluateDemotion,
	evaluateGuardrailBreach,
	evaluatePromotion,
	nextRung,
	previousRung,
} from '../schemas/loop-lifecycle'

describe('loop lifecycle ladder helpers', () => {
	it('exposes the four rungs in order', () => {
		expect(LOOP_RUNGS).toEqual(['draft', 'pilot', 'supervised', 'live'])
	})

	it('nextRung walks the ladder up and stops at live', () => {
		expect(nextRung('draft')).toBe('pilot')
		expect(nextRung('pilot')).toBe('supervised')
		expect(nextRung('supervised')).toBe('live')
		expect(nextRung('live')).toBeNull()
	})

	it('previousRung walks the ladder down and stops at draft', () => {
		expect(previousRung('draft')).toBeNull()
		expect(previousRung('pilot')).toBe('draft')
		expect(previousRung('supervised')).toBe('pilot')
		expect(previousRung('live')).toBe('supervised')
	})
})

describe('evaluatePromotion', () => {
	it('returns no_change for paused and archived', () => {
		expect(evaluatePromotion('paused', 100, 'auto')).toEqual({ kind: 'no_change' })
		expect(evaluatePromotion('archived', 100, 'auto')).toEqual({ kind: 'no_change' })
	})

	it('returns no_change for a null score (no evidence yet)', () => {
		expect(evaluatePromotion('draft', null, 'auto')).toEqual({ kind: 'no_change' })
	})

	it('returns no_change when score is below the rung threshold', () => {
		expect(evaluatePromotion('draft', LOOP_PROMOTION_THRESHOLDS.draft - 1, 'auto')).toEqual({
			kind: 'no_change',
		})
	})

	it('auto-promotes when score >= threshold and mode is auto', () => {
		const decision = evaluatePromotion('pilot', LOOP_PROMOTION_THRESHOLDS.pilot, 'auto')
		expect(decision).toEqual({ kind: 'auto_promote', from: 'pilot', to: 'supervised' })
	})

	it('proposes promotion when score >= threshold and mode is human_approved', () => {
		const decision = evaluatePromotion('supervised', 100, 'human_approved')
		expect(decision).toEqual({ kind: 'propose_promotion', from: 'supervised', to: 'live' })
	})

	it('returns no_change at the top of the ladder even at max score', () => {
		expect(evaluatePromotion('live', 100, 'auto')).toEqual({ kind: 'no_change' })
	})
})

describe('evaluateDemotion', () => {
	it('demotes one rung when score < kill_threshold', () => {
		expect(evaluateDemotion('supervised', 5, 20)).toEqual({
			kind: 'demote',
			from: 'supervised',
			to: 'pilot',
		})
	})

	it('is a no-op when score >= kill_threshold', () => {
		expect(evaluateDemotion('supervised', 50, 20)).toEqual({ kind: 'no_change' })
	})

	it('is a no-op when kill_threshold is not configured', () => {
		expect(evaluateDemotion('supervised', 5, null)).toEqual({ kind: 'no_change' })
		expect(evaluateDemotion('supervised', 5, undefined)).toEqual({ kind: 'no_change' })
	})

	it('is a no-op when score is not present', () => {
		expect(evaluateDemotion('supervised', null, 20)).toEqual({ kind: 'no_change' })
	})

	it('does not demote below draft', () => {
		expect(evaluateDemotion('draft', 0, 50)).toEqual({ kind: 'no_change' })
	})

	it('does not touch paused or archived loops', () => {
		expect(evaluateDemotion('paused', 0, 100)).toEqual({ kind: 'no_change' })
		expect(evaluateDemotion('archived', 0, 100)).toEqual({ kind: 'no_change' })
	})
})

describe('evaluateGuardrailBreach', () => {
	it('drops one rung regardless of score', () => {
		expect(evaluateGuardrailBreach('live')).toEqual({
			kind: 'demote',
			from: 'live',
			to: 'supervised',
		})
		expect(evaluateGuardrailBreach('pilot')).toEqual({
			kind: 'demote',
			from: 'pilot',
			to: 'draft',
		})
	})

	it('is a no-op at draft (no lower rung) and for paused/archived', () => {
		expect(evaluateGuardrailBreach('draft')).toEqual({ kind: 'no_change' })
		expect(evaluateGuardrailBreach('paused')).toEqual({ kind: 'no_change' })
		expect(evaluateGuardrailBreach('archived')).toEqual({ kind: 'no_change' })
	})
})
