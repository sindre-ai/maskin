import { describe, expect, it } from 'vitest'
import {
	copenhagenDateAndTime,
	copenhagenOffsetMinutes,
	copenhagenWallToInstant,
	cronCopenhagenToUtc,
	cronUtcToCopenhagen,
	describeCronExpression,
	formatCopenhagenStamp,
} from '../cron-schedule'

const winter = new Date('2026-01-05T08:00:00Z')
const summer = new Date('2026-07-06T08:00:00Z')

describe('Copenhagen time', () => {
	it('is one hour ahead of UTC in winter and two in summer', () => {
		expect(copenhagenOffsetMinutes(winter)).toBe(60)
		expect(copenhagenOffsetMinutes(summer)).toBe(120)
	})

	it('shows 20:00 UTC as 21:00 in winter and 22:00 in summer, with no zone label', () => {
		expect(formatCopenhagenStamp('2026-11-17T20:00:00.000Z')).toBe('2026-11-17 21:00')
		expect(formatCopenhagenStamp('2026-07-17T20:00:00.000Z')).toBe('2026-07-17 22:00')
	})

	it('returns null for something that is not a date', () => {
		expect(formatCopenhagenStamp('soon')).toBeNull()
	})

	it('turns a Copenhagen date and time into the right instant across both seasons', () => {
		expect(copenhagenWallToInstant('2026-11-17', '21:00')?.toISOString()).toBe(
			'2026-11-17T20:00:00.000Z',
		)
		expect(copenhagenWallToInstant('2026-07-17', '22:00')?.toISOString()).toBe(
			'2026-07-17T20:00:00.000Z',
		)
		expect(copenhagenWallToInstant('nope', '22:00')).toBeNull()
	})

	it('reads an instant back as the same Copenhagen date and time', () => {
		const at = copenhagenWallToInstant('2026-11-17', '00:30') as Date
		expect(copenhagenDateAndTime(at)).toEqual({ date: '2026-11-17', time: '00:30' })
	})
})

describe('schedule form fields', () => {
	const daily = {
		frequency: 'daily',
		minute: '0',
		hour: '20',
		dayOfWeek: '1',
		dayOfMonth: '1',
	} as const

	it('shows a stored 20:00 UTC schedule as 21:00 in winter and 22:00 in summer', () => {
		expect(cronUtcToCopenhagen(daily, winter).hour).toBe('21')
		expect(cronUtcToCopenhagen(daily, summer).hour).toBe('22')
	})

	it('stores what was typed in Copenhagen time back as UTC', () => {
		expect(cronCopenhagenToUtc({ ...daily, hour: '21' }, winter).hour).toBe('20')
		expect(cronCopenhagenToUtc({ ...daily, hour: '22' }, summer).hour).toBe('20')
	})

	it('moves the weekday when the conversion crosses midnight, and back again', () => {
		const sundayLate = { ...daily, frequency: 'weekly', hour: '23', dayOfWeek: '0' } as const
		const shown = cronUtcToCopenhagen(sundayLate, winter)
		expect(shown).toMatchObject({ hour: '0', dayOfWeek: '1' })
		expect(cronCopenhagenToUtc(shown, winter)).toMatchObject({ hour: '23', dayOfWeek: '0' })
	})

	it('moves the day of the month across midnight', () => {
		const monthly = { ...daily, frequency: 'monthly', hour: '23', dayOfMonth: '14' } as const
		expect(cronUtcToCopenhagen(monthly, winter)).toMatchObject({ hour: '0', dayOfMonth: '15' })
	})

	it('leaves an hourly schedule alone', () => {
		const hourly = { ...daily, frequency: 'hourly', minute: '15' } as const
		expect(cronUtcToCopenhagen(hourly, summer)).toEqual(hourly)
	})
})

describe('describeCronExpression in plain words', () => {
	const words = (expr: string, now: Date = winter) => describeCronExpression(expr, now)

	it('reads steps of minutes and hours', () => {
		expect(words('*/15 * * * *')).toBe('every 15 minutes')
		expect(words('* * * * *')).toBe('every minute')
		expect(words('0 */6 * * *')).toBe('every 6 hours')
		expect(words('40 */2 * * *')).toBe('every 2 hours at minute 40')
	})

	it('reads weekday ranges and day names in Copenhagen time', () => {
		expect(words('0 9 * * 1-5')).toBe('Monday to Friday at 10:00')
		expect(words('0 3 * * 1-5')).toBe('Monday to Friday at 04:00')
		expect(words('0 3 * * 1-5', summer)).toBe('Monday to Friday at 05:00')
		expect(words('0 9 * * MON')).toBe('every Monday at 10:00')
		expect(words('0 9 * * SAT,SUN')).toBe('Saturday and Sunday at 10:00')
		expect(words('0 9 * * 1,3,5')).toBe('Monday, Wednesday and Friday at 10:00')
	})

	it('reads a list of hours, as several clock times', () => {
		expect(words('30 8,16 * * *')).toBe('every day at 09:30 and 17:30')
	})

	it('moves the weekdays along when the conversion crosses midnight', () => {
		// 23:00 UTC is 00:00 the next day in Copenhagen winter time.
		expect(words('0 23 * * 1-5')).toBe('Tuesday to Saturday at 00:00')
	})

	it('reads a day of the month and a restricted month', () => {
		expect(words('0 9 1 * *')).toBe('on day 1 of each month at 10:00')
		expect(words('0 9 1,15 * *')).toBe('on days 1 and 15 of each month at 10:00')
		expect(words('0 9 * 4-6 1-5')).toBe('Monday to Friday at 11:00 in April to June')
	})

	it('uses the summer or winter offset of the months a schedule runs in, not of today', () => {
		expect(words('0 9 * 6 *')).toBe('every day at 11:00 in June')
		expect(words('0 9 * 6 *', summer)).toBe('every day at 11:00 in June')
		expect(words('0 9 * 12 *', summer)).toBe('every day at 10:00 in December')
		expect(words('0 9 * 11,12 *', summer)).toBe('every day at 10:00 in November and December')
	})

	it('reads a list of hours that does not divide the day as clock times', () => {
		expect(words('0 */5 * * *')).toBe('every day at 01:00, 06:00, 11:00, 16:00 and 21:00')
	})

	it('hands back the raw expression when it cannot be put into words', () => {
		expect(words('*/15 9-17 * * 1-5')).toBe('*/15 9-17 * * 1-5')
		expect(words('0 9 1,15 * 1')).toBe('0 9 1,15 * 1')
		expect(words('0 9 * 1,7 *')).toBe('0 9 * 1,7 *')
		expect(words('0 9 * 3 *')).toBe('0 9 * 3 *')
		expect(words('0 9 * 10 *')).toBe('0 9 * 10 *')
		expect(words('*/7 * * * *')).toBe('*/7 * * * *')
		expect(words('0 9 * * 8')).toBe('0 9 * * 8')
		expect(words('not a cron')).toBe('not a cron')
	})
})
