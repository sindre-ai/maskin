import { describe, expect, it } from 'vitest'
import { nextLocalDayStart, stopLineReached } from '../../services/daily-budget-hold'

describe('stopLineReached', () => {
	const day = { target: 10, stopShare: 100 }

	it('is false under the line and true at it', () => {
		expect(stopLineReached({ ...day, spent: 9.9 })).toBe(false)
		expect(stopLineReached({ ...day, spent: 10 })).toBe(true)
	})

	it('moves the line with the stop-at share', () => {
		expect(stopLineReached({ target: 10, stopShare: 80, spent: 7.9 })).toBe(false)
		expect(stopLineReached({ target: 10, stopShare: 80, spent: 8 })).toBe(true)
		expect(stopLineReached({ target: 10, stopShare: 90, spent: 8.9 })).toBe(false)
		expect(stopLineReached({ target: 10, stopShare: 90, spent: 9 })).toBe(true)
	})
})

describe('nextLocalDayStart', () => {
	it('is the next midnight in UTC', () => {
		expect(nextLocalDayStart(new Date('2026-11-16T15:30:00Z'), 'UTC')?.toISOString()).toBe(
			'2026-11-17T00:00:00.000Z',
		)
	})

	it('is the next midnight in the workspace timezone', () => {
		// 23:30 UTC on 16 Nov is 00:30 on 17 Nov in Oslo (UTC+1), so the next day starts 18 Nov 00:00 Oslo.
		expect(nextLocalDayStart(new Date('2026-11-16T23:30:00Z'), 'Europe/Oslo')?.toISOString()).toBe(
			'2026-11-17T23:00:00.000Z',
		)
	})

	it('is 24 hours later across an ordinary day and 25 across a clock change back', () => {
		// Oslo went back an hour on 25 Oct 2026: that day has 25 hours.
		const start = nextLocalDayStart(new Date('2026-10-24T12:00:00Z'), 'Europe/Oslo')
		const after = nextLocalDayStart(new Date('2026-10-25T12:00:00Z'), 'Europe/Oslo')
		expect(start?.toISOString()).toBe('2026-10-24T22:00:00.000Z')
		expect(after?.toISOString()).toBe('2026-10-25T23:00:00.000Z')
	})

	it('is null for a timezone it cannot read', () => {
		expect(nextLocalDayStart(new Date('2026-11-16T12:00:00Z'), 'Not/AZone')).toBeNull()
	})
})
