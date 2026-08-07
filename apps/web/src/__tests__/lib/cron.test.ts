import { describeCronExpression } from '@/lib/cron'
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
})
