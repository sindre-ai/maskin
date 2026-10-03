import { describe, expect, it } from 'vitest'
import { SLOT_COUNT, findSlots, searchRange } from '../../../lib/outreach/voice/slots'
import { copenhagenParts } from '../../../lib/outreach/voice/workdays'

// Monday 2026-10-05 08:00 Copenhagen (CEST, UTC+2).
const NOW = new Date('2026-10-05T06:00:00Z')

describe('findSlots', () => {
	it('offers three slots on three different workdays, inside 10:00-16:00 Copenhagen', () => {
		const slots = findSlots([], NOW)
		expect(slots).toHaveLength(SLOT_COUNT)
		const days = slots.map((s) => {
			const p = copenhagenParts(new Date(s.start_iso))
			expect(p.hour).toBeGreaterThanOrEqual(10)
			expect(p.hour).toBeLessThan(16)
			return `${p.year}-${p.month}-${p.day}`
		})
		expect(new Set(days).size).toBe(3)
	})

	it('never offers a slot sooner than 24 hours out', () => {
		for (const s of findSlots([], NOW)) {
			expect(Date.parse(s.start_iso)).toBeGreaterThanOrEqual(NOW.getTime() + 24 * 3600_000)
		}
	})

	it('skips weekends', () => {
		// Friday 2026-10-09 08:00: the next workday is Monday.
		const friday = new Date('2026-10-09T06:00:00Z')
		for (const s of findSlots([], friday)) {
			const dow = new Date(s.start_iso).getUTCDay()
			expect([0, 6]).not.toContain(dow)
		}
	})

	it('skips a slot that overlaps a busy block and takes the next free half hour', () => {
		const first = findSlots([], NOW)[0]
		const busy = [{ start: first?.start_iso as string, end: first?.end_iso as string }]
		const next = findSlots(busy, NOW)[0]
		expect(next?.start_iso).not.toBe(first?.start_iso)
		expect(Date.parse(next?.start_iso as string)).toBeGreaterThanOrEqual(
			Date.parse(first?.end_iso as string),
		)
	})

	it('returns fewer than three, or none, when the calendar is full', () => {
		const range = searchRange(NOW)
		const fullyBusy = [{ start: range.timeMin.toISOString(), end: range.timeMax.toISOString() }]
		expect(findSlots(fullyBusy, NOW)).toEqual([])
	})
})
