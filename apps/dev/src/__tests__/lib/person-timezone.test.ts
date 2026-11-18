import type { Database } from '@maskin/db'
import {
	DEFAULT_AGENT_TIMEZONE,
	formatPersonClockLine,
	resolvePersonTimezone,
} from '../../lib/person-timezone'

/** A db whose select chain ends in the given rows. */
function dbWithRows(rows: unknown[]): Database {
	const chain = { from: () => chain, where: () => chain, limit: async () => rows }
	return { select: () => chain } as unknown as Database
}

describe('formatPersonClockLine', () => {
	// 15:25 UTC on 17 Nov is 10:25 in New York (EST) and 16:25 in Copenhagen (CET).
	const now = new Date('2026-11-17T15:25:00Z')

	it('gives the time in the person zone, not UTC', () => {
		const line = formatPersonClockLine(now, 'America/New_York')
		expect(line).toContain('Tuesday 17 November 2026, 10:25 (America/New_York)')
		expect(line).not.toContain('15:25')
	})

	it('tells the agent to speak in that zone and to avoid UTC', () => {
		const line = formatPersonClockLine(now, 'Europe/Copenhagen')
		expect(line).toContain('16:25 (Europe/Copenhagen)')
		expect(line).toContain('never in UTC unless they ask')
		expect(line).toContain('in 15 minutes')
		expect(line).toContain('TZ=Europe/Copenhagen date')
	})
})

describe('resolvePersonTimezone', () => {
	it('returns the saved timezone', async () => {
		const db = dbWithRows([{ timezone: 'America/New_York' }])
		expect(await resolvePersonTimezone(db, 'actor-1')).toBe('America/New_York')
	})

	it('falls back to Copenhagen when nothing is saved', async () => {
		expect(await resolvePersonTimezone(dbWithRows([]), 'actor-1')).toBe(DEFAULT_AGENT_TIMEZONE)
		expect(await resolvePersonTimezone(dbWithRows([{ timezone: null }]), 'actor-1')).toBe(
			DEFAULT_AGENT_TIMEZONE,
		)
	})

	it('falls back when the stored value is not a known zone, or there is no person', async () => {
		const bad = dbWithRows([{ timezone: 'Not/AZone' }])
		expect(await resolvePersonTimezone(bad, 'actor-1')).toBe(DEFAULT_AGENT_TIMEZONE)
		expect(await resolvePersonTimezone(dbWithRows([]), null)).toBe(DEFAULT_AGENT_TIMEZONE)
	})
})
