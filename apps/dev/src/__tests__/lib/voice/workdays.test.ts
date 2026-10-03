import { describe, expect, it } from 'vitest'
import { addWorkdays, copenhagenDay, copenhagenToUtc } from '../../../lib/outreach/voice/workdays'

// October 2026: Fri 2, Sat 3, Sun 4, Mon 5. Copenhagen is CEST (UTC+2) until Sun 25 Oct.
const z = (iso: string) => new Date(iso)

describe('addWorkdays (Europe/Copenhagen, 09:00-16:00 window)', () => {
	it('keeps the same wall-clock time on the next workday when it is inside the window', () => {
		// Thu 10:30 CEST -> Fri 10:30 CEST
		expect(addWorkdays(z('2026-10-01T08:30:00Z'), 1).toISOString()).toBe('2026-10-02T08:30:00.000Z')
	})

	it('skips the weekend', () => {
		// Fri 15:50 CEST -> Mon 15:50 CEST
		expect(addWorkdays(z('2026-10-02T13:50:00Z'), 1).toISOString()).toBe('2026-10-05T13:50:00.000Z')
	})

	it('starting on a weekend lands on the next workday', () => {
		// Sat 11:00 CEST + 1 workday -> Mon 11:00 CEST
		expect(addWorkdays(z('2026-10-03T09:00:00Z'), 1).toISOString()).toBe('2026-10-05T09:00:00.000Z')
	})

	it('moves a before-window time to 09:00 on the target day', () => {
		// Thu 07:00 CEST -> Fri 09:00 CEST
		expect(addWorkdays(z('2026-10-01T05:00:00Z'), 1).toISOString()).toBe('2026-10-02T07:00:00.000Z')
	})

	it('moves an after-window time to 09:00 on the workday after the target', () => {
		// Mon 16:30 CEST + 1 -> Tue is the target, 16:30 is outside the window -> Wed 09:00 CEST
		expect(addWorkdays(z('2026-10-05T14:30:00Z'), 1).toISOString()).toBe('2026-10-07T07:00:00.000Z')
	})

	it('16:00 sharp is already outside the window', () => {
		// Mon 16:00 CEST + 1 -> Wed 09:00 CEST
		expect(addWorkdays(z('2026-10-05T14:00:00Z'), 1).toISOString()).toBe('2026-10-07T07:00:00.000Z')
	})

	it('adds two workdays', () => {
		// Thu 11:00 CEST + 2 -> Mon 11:00 CEST
		expect(addWorkdays(z('2026-10-01T09:00:00Z'), 2).toISOString()).toBe('2026-10-05T09:00:00.000Z')
	})

	it('follows the clock change when the target is after the DST switch', () => {
		// Fri 23 Oct 10:00 CEST (08:00Z) + 2 workdays -> Tue 27 Oct 10:00 CET (09:00Z)
		expect(addWorkdays(z('2026-10-23T08:00:00Z'), 2).toISOString()).toBe('2026-10-27T09:00:00.000Z')
	})
})

describe('copenhagen helpers', () => {
	it('copenhagenDay uses the local calendar day, not the UTC one', () => {
		// 23:30Z on the 1st is 01:30 on the 2nd in Copenhagen (CEST)
		expect(copenhagenDay(z('2026-10-01T23:30:00Z'))).toBe('2026-10-02')
	})

	it('copenhagenToUtc inverts the zone offset', () => {
		expect(copenhagenToUtc(2026, 10, 5, 9, 0).toISOString()).toBe('2026-10-05T07:00:00.000Z')
		expect(copenhagenToUtc(2026, 11, 2, 9, 0).toISOString()).toBe('2026-11-02T08:00:00.000Z')
	})
})
