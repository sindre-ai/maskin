import { describe, expect, it } from 'vitest'
import { isWithinActiveHours, localHourMinute, parseActiveHours } from '../active-hours'

describe('parseActiveHours', () => {
	it('parses HH:MM-HH:MM', () => {
		const w = parseActiveHours('07:00-23:00', 'Europe/Copenhagen')
		expect(w.start).toEqual({ hour: 7, minute: 0 })
		expect(w.end).toEqual({ hour: 23, minute: 0 })
		expect(w.timezone).toBe('Europe/Copenhagen')
	})

	it('accepts an en-dash as separator (matches the brief prose)', () => {
		const w = parseActiveHours('07:00\u201323:00', 'Europe/Copenhagen')
		expect(w.start.hour).toBe(7)
		expect(w.end.hour).toBe(23)
	})

	it('rejects malformed input', () => {
		expect(() => parseActiveHours('bad', 'UTC')).toThrow()
		expect(() => parseActiveHours('25:00-26:00', 'UTC')).toThrow()
	})
})

describe('localHourMinute (Intl-based, DST-aware)', () => {
	it('gives 07:00 Copenhagen local for 05:00 UTC in winter (CET = +01:00)', () => {
		// 2026-01-15 is winter → Europe/Copenhagen is CET (UTC+1)
		const at = new Date('2026-01-15T06:00:00.000Z') // 07:00 CET
		expect(localHourMinute(at, 'Europe/Copenhagen')).toEqual({ hour: 7, minute: 0 })
	})

	it('gives 07:00 Copenhagen local for 05:00 UTC in summer (CEST = +02:00)', () => {
		// 2026-07-15 is summer → Europe/Copenhagen is CEST (UTC+2)
		const at = new Date('2026-07-15T05:00:00.000Z') // 07:00 CEST
		expect(localHourMinute(at, 'Europe/Copenhagen')).toEqual({ hour: 7, minute: 0 })
	})
})

describe('isWithinActiveHours', () => {
	const window = parseActiveHours('07:00-23:00', 'Europe/Copenhagen')

	it('is true at exactly 07:00 local (window start is inclusive)', () => {
		const at = new Date('2026-07-15T05:00:00.000Z') // 07:00 CEST
		expect(isWithinActiveHours(at, window)).toBe(true)
	})

	it('is false at 06:59 local (before the window)', () => {
		const at = new Date('2026-07-15T04:59:00.000Z') // 06:59 CEST
		expect(isWithinActiveHours(at, window)).toBe(false)
	})

	it('is false at exactly 23:00 local (window end is exclusive)', () => {
		const at = new Date('2026-07-15T21:00:00.000Z') // 23:00 CEST
		expect(isWithinActiveHours(at, window)).toBe(false)
	})

	it('is true at 22:59 local', () => {
		const at = new Date('2026-07-15T20:59:00.000Z') // 22:59 CEST
		expect(isWithinActiveHours(at, window)).toBe(true)
	})

	it('follows DST across the spring transition (07:00 local stays in-window on both sides)', () => {
		// DST for Europe/Copenhagen 2026: CET→CEST at 01:00 UTC on 2026-03-29
		const beforeDst = new Date('2026-03-28T06:00:00.000Z') // 07:00 CET
		const afterDst = new Date('2026-03-30T05:00:00.000Z') // 07:00 CEST
		expect(isWithinActiveHours(beforeDst, window)).toBe(true)
		expect(isWithinActiveHours(afterDst, window)).toBe(true)
	})

	it('follows DST across the autumn transition (23:00 rule holds on both sides)', () => {
		// CEST→CET at 01:00 UTC on 2026-10-25
		const beforeDst = new Date('2026-10-24T20:59:00.000Z') // 22:59 CEST → in
		const afterDst = new Date('2026-10-26T22:01:00.000Z') // 23:01 CET → out
		expect(isWithinActiveHours(beforeDst, window)).toBe(true)
		expect(isWithinActiveHours(afterDst, window)).toBe(false)
	})
})
