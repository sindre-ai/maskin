import { copenhagenParts, copenhagenToUtc } from './workdays'

export const SLOT_MINUTES = 30
export const SLOT_OPTIONS = 3
const LOOKAHEAD_WORKDAYS = 7
const MORNING_HOURS = [10, 11]
const AFTERNOON_HOURS = [13, 14, 15]

export interface Slot {
	start_iso: string
	end_iso: string
}

export interface BusyWindow {
	start: string
	end: string
}

export type DayPart = 'morning' | 'afternoon' | null

/** Reads a free-text window ("morning", "i eftermiddag") as a bias, nothing finer. */
export function dayPartOf(preferredWindow: string | undefined): DayPart {
	const text = (preferredWindow ?? '').toLowerCase()
	if (/morning|formiddag|morgen/.test(text)) return 'morning'
	if (/afternoon|eftermiddag/.test(text)) return 'afternoon'
	return null
}

/** The range freebusy has to cover for proposeSlots. */
export function slotSearchRange(now: Date): { from: Date; to: Date } {
	const p = copenhagenParts(now)
	const from = copenhagenToUtc(p.year, p.month, p.day + 1, 0, 0)
	const to = copenhagenToUtc(p.year, p.month, p.day + 1 + LOOKAHEAD_WORKDAYS * 2, 0, 0)
	return { from, to }
}

/**
 * Three half-hour options on workdays from tomorrow, at 10-12 and 13-16 Copenhagen time, that do
 * not overlap a busy interval. One option per day while there are enough days, so the prospect is
 * offered a spread rather than three times on the same afternoon.
 */
export function proposeSlots(
	busy: readonly BusyWindow[],
	now: Date,
	preferredWindow?: string,
): Slot[] {
	const part = dayPartOf(preferredWindow)
	const hours =
		part === 'morning'
			? MORNING_HOURS
			: part === 'afternoon'
				? AFTERNOON_HOURS
				: [...MORNING_HOURS, ...AFTERNOON_HOURS]
	const intervals = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
	const p = copenhagenParts(now)

	const perDay: Slot[][] = []
	let workdays = 0
	for (
		let offset = 1;
		workdays < LOOKAHEAD_WORKDAYS && offset <= LOOKAHEAD_WORKDAYS * 2;
		offset++
	) {
		const dow = new Date(Date.UTC(p.year, p.month - 1, p.day + offset)).getUTCDay()
		if (dow === 0 || dow === 6) continue
		workdays++
		const free: Slot[] = []
		for (const hour of hours) {
			const start = copenhagenToUtc(p.year, p.month, p.day + offset, hour, 0)
			const end = new Date(start.getTime() + SLOT_MINUTES * 60_000)
			const clash = intervals.some(([bs, be]) => bs < end.getTime() && be > start.getTime())
			if (!clash) free.push({ start_iso: start.toISOString(), end_iso: end.toISOString() })
		}
		if (free.length > 0) perDay.push(free)
	}

	const picked: Slot[] = []
	for (let round = 0; picked.length < SLOT_OPTIONS; round++) {
		let added = false
		for (const day of perDay) {
			const slot = day[round]
			if (!slot) continue
			picked.push(slot)
			added = true
			if (picked.length === SLOT_OPTIONS) break
		}
		if (!added) break
	}
	return picked
}
