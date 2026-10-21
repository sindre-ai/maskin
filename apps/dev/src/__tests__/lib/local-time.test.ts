import { localClock, localTimeReached } from '../../lib/local-time'

describe('localClock', () => {
	it('reads date and minute in the actor timezone', () => {
		// 2026-03-10T07:30Z is 08:30 in Oslo (CET, UTC+1) and 03:30 in New York (EDT, UTC-4).
		const at = new Date('2026-03-10T07:30:00Z')
		expect(localClock(at, 'Europe/Oslo')).toEqual({ date: '2026-03-10', minute: 8 * 60 + 30 })
		expect(localClock(at, 'America/New_York')).toEqual({ date: '2026-03-10', minute: 3 * 60 + 30 })
	})

	it('rolls the local date across midnight', () => {
		const at = new Date('2026-03-10T23:30:00Z')
		expect(localClock(at, 'Asia/Tokyo')).toEqual({ date: '2026-03-11', minute: 8 * 60 + 30 })
		expect(localClock(at, 'Pacific/Honolulu')).toEqual({ date: '2026-03-10', minute: 13 * 60 + 30 })
	})

	it('returns null for an invalid timezone or date instead of throwing or guessing UTC', () => {
		const at = new Date('2026-03-10T07:30:00Z')
		expect(localClock(at, 'Not/AZone')).toBeNull()
		expect(localClock(at, '')).toBeNull()
		expect(localClock(new Date('nope'), 'Europe/Oslo')).toBeNull()
	})

	it('reports midnight as minute 0, not 1440', () => {
		expect(localClock(new Date('2026-03-10T23:00:00Z'), 'Europe/Oslo')).toEqual({
			date: '2026-03-11',
			minute: 0,
		})
	})
})

describe('localTimeReached', () => {
	const t = 8 * 60 + 30
	it('is null before the target, set from the target on, null again after the window', () => {
		// Oslo is UTC+1 on 2026-03-10.
		expect(localTimeReached(new Date('2026-03-10T07:29:00Z'), 'Europe/Oslo', t, 180)).toBeNull()
		expect(localTimeReached(new Date('2026-03-10T07:30:00Z'), 'Europe/Oslo', t, 180)?.date).toBe(
			'2026-03-10',
		)
		expect(localTimeReached(new Date('2026-03-10T10:29:00Z'), 'Europe/Oslo', t, 180)).not.toBeNull()
		expect(localTimeReached(new Date('2026-03-10T10:30:00Z'), 'Europe/Oslo', t, 180)).toBeNull()
	})

	it('differs per timezone for the same instant', () => {
		const at = new Date('2026-03-10T07:30:00Z')
		expect(localTimeReached(at, 'Europe/Oslo', t, 180)).not.toBeNull()
		expect(localTimeReached(at, 'America/New_York', t, 180)).toBeNull()
	})

	it('spring forward: a target inside the skipped hour fires at the first real minute after it', () => {
		// Oslo 2026-03-29: 02:00 CET jumps to 03:00 CEST. Target 02:30 never exists locally.
		const target = 2 * 60 + 30
		expect(
			localTimeReached(new Date('2026-03-29T00:59:00Z'), 'Europe/Oslo', target, 180),
		).toBeNull() // 01:59
		const first = localTimeReached(new Date('2026-03-29T01:00:00Z'), 'Europe/Oslo', target, 180) // 03:00
		expect(first).toEqual({ date: '2026-03-29', minute: 3 * 60 })
	})

	it('fall back: the repeated hour yields the same local date both times (claim keeps it once)', () => {
		// Oslo 2026-10-25: 03:00 CEST falls back to 02:00 CET, so 02:30 happens twice.
		const target = 2 * 60 + 30
		const a = localTimeReached(new Date('2026-10-25T00:30:00Z'), 'Europe/Oslo', target, 60) // 02:30 CEST
		const b = localTimeReached(new Date('2026-10-25T01:30:00Z'), 'Europe/Oslo', target, 60) // 02:30 CET
		expect(a?.date).toBe('2026-10-25')
		expect(b?.date).toBe('2026-10-25')
	})

	it('an invalid timezone is never due', () => {
		expect(localTimeReached(new Date('2026-03-10T07:30:00Z'), 'Mars/Olympus', 0, 1440)).toBeNull()
	})
})
