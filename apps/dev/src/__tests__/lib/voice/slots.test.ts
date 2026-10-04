import { describe, expect, it } from 'vitest'
import { dayPartOf, proposeSlots, slotSearchRange } from '../../../lib/outreach/voice/slots'

// Monday 2026-10-05, 11:30 in Copenhagen (UTC+2).
const NOW = new Date('2026-10-05T09:30:00Z')

describe('proposeSlots', () => {
	it('offers three half-hour slots on three different workdays from tomorrow', () => {
		const slots = proposeSlots([], NOW)
		expect(slots).toHaveLength(3)
		const days = slots.map((s) => s.start_iso.slice(0, 10))
		expect(new Set(days).size).toBe(3)
		expect(days[0]).toBe('2026-10-06')
		for (const s of slots) {
			expect(Date.parse(s.end_iso) - Date.parse(s.start_iso)).toBe(30 * 60_000)
		}
	})

	it('skips weekends', () => {
		const friday = new Date('2026-10-09T09:30:00Z')
		const days = proposeSlots([], friday).map((s) => new Date(s.start_iso).getUTCDay())
		expect(days.every((d) => d !== 0 && d !== 6)).toBe(true)
	})

	it('does not offer a time that overlaps a busy interval', () => {
		const first = proposeSlots([], NOW)[0]
		const next = proposeSlots([{ start: first?.start_iso ?? '', end: first?.end_iso ?? '' }], NOW)
		expect(next.map((s) => s.start_iso)).not.toContain(first?.start_iso)
		expect(next).toHaveLength(3)
	})

	it('offers more than one slot on a day when there are too few days with room', () => {
		const range = slotSearchRange(NOW)
		// Busy every day except the first one.
		const busy = [{ start: '2026-10-07T00:00:00Z', end: range.to.toISOString() }]
		const slots = proposeSlots(busy, NOW)
		expect(slots.length).toBeGreaterThan(0)
		expect(slots.every((s) => s.start_iso.startsWith('2026-10-06'))).toBe(true)
	})

	it('returns no slots when the whole window is busy', () => {
		const range = slotSearchRange(NOW)
		expect(
			proposeSlots([{ start: range.from.toISOString(), end: range.to.toISOString() }], NOW),
		).toEqual([])
	})

	it('keeps to the morning when asked', () => {
		const slots = proposeSlots([], NOW, 'gerne formiddag')
		for (const s of slots) {
			const hour = Number(
				new Intl.DateTimeFormat('en-GB', {
					timeZone: 'Europe/Copenhagen',
					hour: '2-digit',
					hourCycle: 'h23',
				}).format(new Date(s.start_iso)),
			)
			expect(hour).toBeLessThan(12)
		}
	})

	it('reads morning and afternoon in English and Danish, nothing else', () => {
		expect(dayPartOf('Morning please')).toBe('morning')
		expect(dayPartOf('i eftermiddag')).toBe('afternoon')
		expect(dayPartOf('Tuesday')).toBeNull()
		expect(dayPartOf(undefined)).toBeNull()
	})
})
