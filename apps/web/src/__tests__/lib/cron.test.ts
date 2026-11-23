import {
	describeCopenhagenDateTime,
	describeCronExpression,
	nextCronFire,
	parseCronExpression,
} from '@/lib/cron'
import { describe, expect, it } from 'vitest'

describe('describeCronExpression', () => {
	// The server runs every schedule in UTC; the list shows Copenhagen time.
	// Winter: CET, UTC+1. Summer: CEST, UTC+2.
	const winter = new Date(Date.UTC(2026, 0, 5, 8, 0, 0))
	const summer = new Date(Date.UTC(2026, 6, 6, 8, 0, 0))
	const describe_ = (expr: string, now: Date = winter) => describeCronExpression(expr, now)

	it('converts a daily schedule from UTC to Copenhagen winter time', () => {
		expect(describe_('0 8 * * *')).toBe('every day at 09:00')
		expect(describe_('30 9 * * *')).toBe('every day at 10:30')
	})

	it('converts a daily schedule from UTC to Copenhagen summer time', () => {
		expect(describe_('0 8 * * *', summer)).toBe('every day at 10:00')
		expect(describe_('30 9 * * *', summer)).toBe('every day at 11:30')
	})

	it('uses 24-hour time at midnight and noon', () => {
		expect(describe_('0 23 * * *')).toBe('every day at 00:00')
		expect(describe_('0 11 * * *')).toBe('every day at 12:00')
	})

	it('describes a weekly schedule in Copenhagen time', () => {
		expect(describe_('0 17 * * 0')).toBe('every Sunday at 18:00')
		expect(describe_('0 17 * * 0', summer)).toBe('every Sunday at 19:00')
	})

	it('moves a weekly schedule to the next weekday when the conversion crosses midnight', () => {
		// Sunday 23:00 UTC is Monday 00:00 CET and Monday 01:00 CEST.
		expect(describe_('0 23 * * 0')).toBe('every Monday at 00:00')
		expect(describe_('0 23 * * 0', summer)).toBe('every Monday at 01:00')
	})

	it('treats day-of-week 7 as Sunday', () => {
		expect(describe_('0 17 * * 7')).toBe('every Sunday at 18:00')
	})

	it('describes a monthly schedule in Copenhagen time', () => {
		expect(describe_('0 8 15 * *')).toBe('on day 15 of each month at 09:00')
		expect(describe_('0 8 15 * *', summer)).toBe('on day 15 of each month at 10:00')
	})

	it('moves a monthly schedule to the next day number when the conversion crosses midnight', () => {
		// The 31st at 23:00 UTC is the 1st at 00:00 CET.
		expect(describe_('0 23 31 * *')).toBe('on day 1 of each month at 00:00')
	})

	it('leaves an hourly schedule alone, since the zones differ by whole hours', () => {
		expect(describe_('15 * * * *')).toBe('every hour at minute 15')
	})

	it('describes a fixed day and month as a one-time date in winter time', () => {
		const now = new Date(Date.UTC(2026, 9, 20, 8, 0, 0))
		expect(describe_('0 8 3 11 *', now)).toBe('once on 3 Nov at 09:00')
	})

	it('describes a fixed day and month as a one-time date in summer time', () => {
		expect(describe_('0 8 1 7 *')).toBe('once on 1 Jul at 10:00')
	})

	it('includes the year when the next date is not in the current year', () => {
		const now = new Date(Date.UTC(2026, 10, 17, 8, 0, 0))
		expect(describe_('0 8 3 11 *', now)).toBe('once on 3 Nov 2027 at 09:00')
	})

	it('moves a one-time date to the next day when the conversion crosses midnight', () => {
		expect(describe_('30 23 3 11 *', new Date(Date.UTC(2026, 9, 20)))).toBe(
			'once on 4 Nov at 00:30',
		)
	})

	it('finds the next 29 February', () => {
		expect(describe_('0 9 29 2 *')).toBe('once on 29 Feb 2028 at 10:00')
	})

	it('falls back to the raw expression for a date that never exists', () => {
		expect(describe_('0 9 31 11 *')).toBe('0 9 31 11 *')
	})

	it('describes step syntax in plain words', () => {
		expect(describe_('*/15 * * * *')).toBe('every 15 minutes')
		expect(describe_('0 */4 * * *')).toBe('every 4 hours')
	})

	it('describes list syntax in plain words', () => {
		expect(describe_('30 9,15 * * *')).toBe('every day at 10:30 and 16:30')
	})

	it('describes range syntax in plain words', () => {
		expect(describe_('0 9 * * 1-5')).toBe('Monday to Friday at 10:00')
	})

	it('describes day names in plain words', () => {
		expect(describe_('0 9 * * MON')).toBe('every Monday at 10:00')
	})

	it('falls back to the raw expression for a schedule it will not guess at', () => {
		expect(describe_('*/15 9-17 * * 1-5')).toBe('*/15 9-17 * * 1-5')
	})

	it('falls back to the raw expression for malformed input', () => {
		expect(describe_('')).toBe('')
		expect(describe_('not a cron')).toBe('not a cron')
	})

	it('drops a leading seconds field on 6-field cron', () => {
		expect(describe_('0 0 8 * * *')).toBe('every day at 09:00')
	})

	it('falls back to the raw expression for a restricted month with a wildcard day', () => {
		expect(describe_('0 9 * 6 *')).toBe('0 9 * 6 *')
	})

	it('falls back to the raw expression for a restricted month and weekday', () => {
		expect(describe_('0 9 1 6 1')).toBe('0 9 1 6 1')
	})

	it('falls back to the raw expression when hour is wildcard but day-of-week is restricted', () => {
		expect(describe_('0 * * * 0')).toBe('0 * * * 0')
	})

	it('falls back to the raw expression when minute is wildcard but day-of-month is restricted', () => {
		expect(describe_('* 8 15 * *')).toBe('* 8 15 * *')
	})

	it('falls back to the raw expression for out-of-range field values', () => {
		expect(describe_('0 25 * * 1')).toBe('0 25 * * 1')
		expect(describe_('60 9 * * *')).toBe('60 9 * * *')
		expect(describe_('0 9 32 * *')).toBe('0 9 32 * *')
		expect(describe_('0 9 0 * *')).toBe('0 9 0 * *')
		expect(describe_('0 9 * * 8')).toBe('0 9 * * 8')
		expect(describe_('0 9 1 13 *')).toBe('0 9 1 13 *')
	})
})

describe('nextCronFire', () => {
	// Monday 2026-01-05 08:00:00 UTC. The server runs schedules in UTC, so the
	// next fire is read in UTC whatever zone the browser is in.
	const now = new Date(Date.UTC(2026, 0, 5, 8, 0, 0))

	it('returns null for a cron expression the parser rejects', () => {
		expect(nextCronFire('*/15 * * * *', now)).toBeNull()
	})

	it('rolls an hourly cron to the next matching minute', () => {
		expect(nextCronFire('15 * * * *', now)).toEqual(new Date(Date.UTC(2026, 0, 5, 8, 15, 0)))
	})

	it('rolls an hourly cron whose minute has already passed to the next hour', () => {
		expect(nextCronFire('0 * * * *', now)).toEqual(new Date(Date.UTC(2026, 0, 5, 9, 0, 0)))
	})

	it('rolls a daily cron to today when its time is still ahead', () => {
		expect(nextCronFire('0 17 * * *', now)).toEqual(new Date(Date.UTC(2026, 0, 5, 17, 0, 0)))
	})

	it('rolls a daily cron to tomorrow when its time has already passed', () => {
		expect(nextCronFire('0 7 * * *', now)).toEqual(new Date(Date.UTC(2026, 0, 6, 7, 0, 0)))
	})

	it('rolls a weekly cron to the next matching day-of-week', () => {
		// From Monday 08:00, next Sunday at 17:00 is 6 days out.
		expect(nextCronFire('0 17 * * 0', now)).toEqual(new Date(Date.UTC(2026, 0, 11, 17, 0, 0)))
	})

	it('rolls a weekly cron that matches today but is already past to next week', () => {
		// Monday 07:00 has passed at 08:00 — next fire is next Monday.
		expect(nextCronFire('0 7 * * 1', now)).toEqual(new Date(Date.UTC(2026, 0, 12, 7, 0, 0)))
	})

	it('rolls a monthly cron to next month when this month has already passed', () => {
		// Day 3 of January is behind now (2026-01-05 08:00) — next fire is Feb 3.
		expect(nextCronFire('0 9 3 * *', now)).toEqual(new Date(Date.UTC(2026, 1, 3, 9, 0, 0)))
	})

	it('reads a fixed day and month as a one-time date in UTC', () => {
		expect(nextCronFire('0 8 3 11 *', now)).toEqual(new Date(Date.UTC(2026, 10, 3, 8, 0, 0)))
		// Already past this year: next year.
		expect(nextCronFire('0 8 3 1 *', now)).toEqual(new Date(Date.UTC(2027, 0, 3, 8, 0, 0)))
	})
})

describe('describeCopenhagenDateTime', () => {
	const now = new Date(Date.UTC(2026, 0, 5, 8, 0, 0))

	it('shows the date and 24-hour time in Copenhagen winter and summer time', () => {
		expect(describeCopenhagenDateTime(new Date('2026-11-03T08:00:00Z'), now)).toBe('3 Nov at 09:00')
		expect(describeCopenhagenDateTime(new Date('2026-07-03T08:00:00Z'), now)).toBe('3 Jul at 10:00')
	})

	it('follows the Copenhagen date when the conversion crosses midnight', () => {
		expect(describeCopenhagenDateTime(new Date('2026-11-03T23:30:00Z'), now)).toBe('4 Nov at 00:30')
	})
})

describe('parseCronExpression', () => {
	it('returns null for unsupported syntax instead of guessing', () => {
		expect(parseCronExpression('*/15 * * * *')).toBeNull()
		expect(parseCronExpression('0 9 * * MON')).toBeNull()
		expect(parseCronExpression('garbage')).toBeNull()
	})

	it('returns null for a restricted month field', () => {
		expect(parseCronExpression('0 9 1 6 *')).toBeNull()
	})

	it('returns null for out-of-range field values', () => {
		expect(parseCronExpression('0 25 * * 1')).toBeNull()
		expect(parseCronExpression('60 9 * * *')).toBeNull()
		expect(parseCronExpression('0 9 32 * *')).toBeNull()
	})
})
