import { describeCronExpression, parseCronExpression } from '@/lib/cron'
import { describe, expect, it } from 'vitest'

describe('describeCronExpression', () => {
	it('describes a weekly schedule', () => {
		expect(describeCronExpression('0 17 * * 0')).toBe('every Sunday at 5:00 PM')
	})

	it('describes a daily schedule', () => {
		expect(describeCronExpression('30 9 * * *')).toBe('every day at 9:30 AM')
	})

	it('describes a monthly schedule', () => {
		expect(describeCronExpression('0 8 15 * *')).toBe('on day 15 of each month at 8:00 AM')
	})

	it('describes an hourly schedule', () => {
		expect(describeCronExpression('15 * * * *')).toBe('every hour at minute 15')
	})

	it('formats midnight and noon in 12-hour time', () => {
		expect(describeCronExpression('0 0 * * *')).toBe('every day at 12:00 AM')
		expect(describeCronExpression('0 12 * * *')).toBe('every day at 12:00 PM')
	})

	it('falls back to the raw expression for step syntax', () => {
		expect(describeCronExpression('*/15 * * * *')).toBe('*/15 * * * *')
		expect(describeCronExpression('0 */4 * * *')).toBe('0 */4 * * *')
	})

	it('falls back to the raw expression for list syntax', () => {
		expect(describeCronExpression('30 9,15 * * *')).toBe('30 9,15 * * *')
	})

	it('falls back to the raw expression for range syntax', () => {
		expect(describeCronExpression('0 9 * * 1-5')).toBe('0 9 * * 1-5')
	})

	it('falls back to the raw expression for day names', () => {
		expect(describeCronExpression('0 9 * * MON')).toBe('0 9 * * MON')
	})

	it('falls back to the raw expression for malformed input', () => {
		expect(describeCronExpression('')).toBe('')
		expect(describeCronExpression('not a cron')).toBe('not a cron')
	})

	it('drops a leading seconds field on 6-field cron', () => {
		expect(describeCronExpression('0 0 9 * * *')).toBe('every day at 9:00 AM')
	})
})

describe('parseCronExpression', () => {
	it('returns null for unsupported syntax instead of guessing', () => {
		expect(parseCronExpression('*/15 * * * *')).toBeNull()
		expect(parseCronExpression('0 9 * * MON')).toBeNull()
		expect(parseCronExpression('garbage')).toBeNull()
	})
})
