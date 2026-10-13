import { describe, expect, it } from 'vitest'
import {
	MAX_DURATION_HOURS,
	effectiveTier,
	parseAccessDuration,
} from '../../lib/integrations/access-requests'

describe('parseAccessDuration', () => {
	it('accepts a session', () => {
		expect(parseAccessDuration('session')).toEqual({
			ok: true,
			normalized: 'session',
			kind: 'session',
		})
		expect(parseAccessDuration('  Session ')).toMatchObject({ ok: true, kind: 'session' })
	})

	it('accepts whole hours and days up to seven days', () => {
		expect(parseAccessDuration('2h')).toEqual({
			ok: true,
			normalized: '2h',
			kind: 'timed',
			hours: 2,
		})
		expect(parseAccessDuration('3D')).toMatchObject({ ok: true, normalized: '3d', hours: 72 })
		expect(parseAccessDuration('7d')).toMatchObject({ ok: true, hours: MAX_DURATION_HOURS })
		expect(parseAccessDuration('168h')).toMatchObject({ ok: true, hours: MAX_DURATION_HOURS })
	})

	it('rejects anything over seven days', () => {
		expect(parseAccessDuration('8d')).toEqual({ ok: false, reason: 'too_long' })
		expect(parseAccessDuration('169h')).toEqual({ ok: false, reason: 'too_long' })
		expect(parseAccessDuration('9999d')).toEqual({ ok: false, reason: 'too_long' })
	})

	it('rejects the wrong form', () => {
		for (const bad of [
			'',
			'0h',
			'0d',
			'1.5h',
			'-1d',
			'2 days',
			'forever',
			'1w',
			'10000h',
			'2h;3d',
		]) {
			expect(parseAccessDuration(bad)).toEqual({ ok: false, reason: 'form' })
		}
	})
})

describe('effectiveTier', () => {
	it('counts unset as Tier 2', () => {
		expect(effectiveTier(null)).toBe(2)
		expect(effectiveTier(undefined)).toBe(2)
	})

	it('passes a stored tier through', () => {
		expect(effectiveTier(1)).toBe(1)
		expect(effectiveTier(2)).toBe(2)
		expect(effectiveTier(3)).toBe(3)
	})

	it('treats an out-of-range value as Tier 2 rather than trusting it', () => {
		expect(effectiveTier(0)).toBe(2)
		expect(effectiveTier(4)).toBe(2)
	})
})
