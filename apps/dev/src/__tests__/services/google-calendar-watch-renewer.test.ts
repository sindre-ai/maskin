import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock for renewGoogleCalendarWatch.
const renewSpy = vi.hoisted(() => vi.fn())

vi.mock('../../lib/integrations/providers/google-calendar/watch', () => ({
	renewGoogleCalendarWatch: renewSpy,
	GoogleCalendarIntegrationConfig: undefined,
}))

import { GoogleCalendarWatchRenewer } from '../../services/google-calendar-watch-renewer'

interface FakeRow {
	id: string
	provider: string
	status: string
	config: { googleCalendar?: { channelExpiration: number } } | null
}

function makeFakeDb(rows: FakeRow[]) {
	return {
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(rows),
			}),
		}),
	} as unknown as Parameters<typeof GoogleCalendarWatchRenewer.prototype.constructor>[0]
}

describe('GoogleCalendarWatchRenewer', () => {
	beforeEach(() => {
		renewSpy.mockReset().mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('renews channels whose expiration is within 48h', async () => {
		const soon = Date.now() + 24 * 60 * 60 * 1000 // 24h from now — inside window
		const fresh = Date.now() + 6 * 24 * 60 * 60 * 1000 // 6 days from now — outside window

		const db = makeFakeDb([
			{
				id: 'expiring',
				provider: 'google-calendar',
				status: 'active',
				config: { googleCalendar: { channelExpiration: soon } },
			},
			{
				id: 'fresh',
				provider: 'google-calendar',
				status: 'active',
				config: { googleCalendar: { channelExpiration: fresh } },
			},
		])

		const renewer = new GoogleCalendarWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()

		expect(renewSpy).toHaveBeenCalledTimes(1)
		expect(renewSpy).toHaveBeenCalledWith(db, 'expiring')
	})

	it('keeps the 48h margin (a channel 36h out is still renewed)', async () => {
		// The Gmail renewer uses 24h, which Devon flagged as too thin. This test
		// pins our 48h floor so a refactor can't silently revert to 24h.
		const justInsideWindow = Date.now() + 36 * 60 * 60 * 1000 // 36h
		const db = makeFakeDb([
			{
				id: '36h-out',
				provider: 'google-calendar',
				status: 'active',
				config: { googleCalendar: { channelExpiration: justInsideWindow } },
			},
		])

		const renewer = new GoogleCalendarWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()
		expect(renewSpy).toHaveBeenCalledWith(db, '36h-out')
	})

	it('treats channelExpiration=0 (never registered) as due for renewal', async () => {
		const db = makeFakeDb([
			{
				id: 'never-watched',
				provider: 'google-calendar',
				status: 'active',
				config: { googleCalendar: { channelExpiration: 0 } },
			},
			{ id: 'no-config', provider: 'google-calendar', status: 'active', config: null },
		])

		const renewer = new GoogleCalendarWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()

		expect(renewSpy).toHaveBeenCalledTimes(2)
	})

	it('continues renewing remaining rows when one fails', async () => {
		renewSpy.mockReset()
		renewSpy.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)

		const soon = Date.now() + 1000
		const db = makeFakeDb([
			{
				id: 'a',
				provider: 'google-calendar',
				status: 'active',
				config: { googleCalendar: { channelExpiration: soon } },
			},
			{
				id: 'b',
				provider: 'google-calendar',
				status: 'active',
				config: { googleCalendar: { channelExpiration: soon } },
			},
		])

		const renewer = new GoogleCalendarWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()

		expect(renewSpy).toHaveBeenCalledTimes(2)
	})
})
