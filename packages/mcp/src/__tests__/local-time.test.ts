import { describe, expect, it } from 'vitest'
import { formatLocalTime, withLocalTimes } from '../local-time.js'

describe('formatLocalTime', () => {
	it('gives the same moment in the zone asked for', () => {
		// 15:25 UTC on 17 Nov is 10:25 in New York and 16:25 in Copenhagen.
		expect(formatLocalTime('2026-11-17T15:25:00.000Z', 'America/New_York')).toBe(
			'Tue 17 Nov 2026, 10:25 (America/New_York)',
		)
		expect(formatLocalTime('2026-11-17T15:25:00.000Z', 'Europe/Copenhagen')).toBe(
			'Tue 17 Nov 2026, 16:25 (Europe/Copenhagen)',
		)
	})

	it('returns null for a missing time, a bad time or an unknown zone', () => {
		expect(formatLocalTime(null, 'Europe/Copenhagen')).toBeNull()
		expect(formatLocalTime('soon', 'Europe/Copenhagen')).toBeNull()
		expect(formatLocalTime('2026-11-17T15:25:00Z', 'Not/AZone')).toBeNull()
	})
})

describe('withLocalTimes', () => {
	it('adds a _local twin next to each listed time and leaves the rest alone', () => {
		const out = withLocalTimes(
			{ id: 'a', due_at: '2026-11-17T15:25:00Z', closed_at: null },
			['due_at', 'closed_at'],
			'America/New_York',
		)
		expect(out.due_at).toBe('2026-11-17T15:25:00Z')
		expect(out.due_at_local).toBe('Tue 17 Nov 2026, 10:25 (America/New_York)')
		expect(out).not.toHaveProperty('closed_at_local')
		expect(out.id).toBe('a')
	})
})
