import { describe, expect, it } from 'vitest'
import { DOLLAR_UNIT_LOCKED_REASON, evaluateDollarUnit } from '../../lib/daily-budget'

const day = (date: string, ended: number, zero: number) => ({
	date,
	ended_sessions: ended,
	zero_cost_sessions: zero,
})

describe('evaluateDollarUnit', () => {
	it('is available with no sessions at all', () => {
		expect(evaluateDollarUnit([])).toEqual({ available: true, reason: null, days: [] })
	})

	it('is available when every day is under 5% zero-cost', () => {
		const days = [day('2026-10-24', 100, 4), day('2026-10-25', 50, 0)]
		expect(evaluateDollarUnit(days)).toEqual({ available: true, reason: null, days })
	})

	it('locks at exactly 5% on any one day and says why', () => {
		const result = evaluateDollarUnit([day('2026-10-24', 100, 0), day('2026-10-25', 100, 5)])
		expect(result.available).toBe(false)
		expect(result.reason).toBe(DOLLAR_UNIT_LOCKED_REASON)
	})

	it('locks when the cost numbers are broken like on 25 Oct (1206 of 1208)', () => {
		expect(evaluateDollarUnit([day('2026-10-25', 1208, 1206)]).available).toBe(false)
	})

	it('ignores days with no ended sessions', () => {
		expect(evaluateDollarUnit([day('2026-10-24', 0, 0)]).available).toBe(true)
	})
})
