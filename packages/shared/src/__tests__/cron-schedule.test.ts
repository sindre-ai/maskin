import { describe, expect, it } from 'vitest'
import {
	copenhagenDateAndTime,
	copenhagenOffsetMinutes,
	copenhagenWallToInstant,
	cronCopenhagenToUtc,
	cronUtcToCopenhagen,
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
