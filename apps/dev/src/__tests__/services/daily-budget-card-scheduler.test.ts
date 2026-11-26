import { startOfLocalDay } from '../../services/daily-budget-card-scheduler'

describe('startOfLocalDay', () => {
	it('drops the seconds and milliseconds, so the day starts at exactly 00:00:00.000', () => {
		// 2026-03-10T23:00:27.458Z is 00:00:27.458 on 2026-03-11 in Oslo (CET, UTC+1).
		const start = startOfLocalDay(new Date('2026-03-10T23:00:27.458Z'), 'Europe/Oslo')
		expect(start?.toISOString()).toBe('2026-03-10T23:00:00.000Z')
	})

	it('returns the same instant for any time inside one local day', () => {
		const midnight = '2026-03-10T23:00:00.000Z'
		for (const at of [
			'2026-03-10T23:00:00.000Z',
			'2026-03-11T10:15:42.123Z',
			'2026-03-11T22:59:59.999Z',
		]) {
			expect(startOfLocalDay(new Date(at), 'Europe/Oslo')?.toISOString()).toBe(midnight)
		}
	})

	it('finds midnight on a spring-forward day, with seconds in the input', () => {
		// Oslo 2026-03-29: midnight is CET (UTC+1), the clock jumps at 02:00, so `at` is CEST.
		const start = startOfLocalDay(new Date('2026-03-29T10:15:42.123Z'), 'Europe/Oslo')
		expect(start?.toISOString()).toBe('2026-03-28T23:00:00.000Z')
	})

	it('is null for an invalid timezone', () => {
		expect(startOfLocalDay(new Date('2026-03-10T07:30:00Z'), 'Not/AZone')).toBeNull()
	})
})
