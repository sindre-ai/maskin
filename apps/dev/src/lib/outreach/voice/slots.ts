import type { BusyInterval } from '../../integrations/providers/google-calendar/client'
import { copenhagenParts, copenhagenToUtc } from './workdays'

export const SLOT_MINUTES = 30
export const SLOT_WINDOW_START_HOUR = 10
export const SLOT_WINDOW_END_HOUR = 16
export const SLOT_COUNT = 3
/** Look this many calendar days ahead of the first bookable day. */
export const SLOT_LOOKAHEAD_DAYS = 14
/** Never offer a slot starting sooner than this: the founder needs notice. */
export const SLOT_MIN_NOTICE_MS = 24 * 60 * 60 * 1000

export interface Slot {
	start_iso: string
	end_iso: string
}

export function searchRange(now: Date): { timeMin: Date; timeMax: Date } {
	return {
		timeMin: new Date(now.getTime() + SLOT_MIN_NOTICE_MS),
		timeMax: new Date(now.getTime() + (SLOT_LOOKAHEAD_DAYS + 1) * 24 * 60 * 60 * 1000),
	}
}

/**
 * Up to SLOT_COUNT free 30-minute slots, at most one per Copenhagen workday, so the
 * agent can read out three genuinely different options. Weekends are skipped; Danish
 * public holidays are not modelled (the calendar's own busy blocks are the backstop).
 */
export function findSlots(busy: readonly BusyInterval[], now: Date): Slot[] {
	const blocks = busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
	const earliest = now.getTime() + SLOT_MIN_NOTICE_MS
	const today = copenhagenParts(now)
	const slots: Slot[] = []

	for (let offset = 0; offset <= SLOT_LOOKAHEAD_DAYS && slots.length < SLOT_COUNT; offset++) {
		const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
		const dow = day.getUTCDay()
		if (dow === 0 || dow === 6) continue
		const y = day.getUTCFullYear()
		const m = day.getUTCMonth() + 1
		const d = day.getUTCDate()

		const dayEnd = copenhagenToUtc(y, m, d, SLOT_WINDOW_END_HOUR, 0).getTime()
		for (
			let start = copenhagenToUtc(y, m, d, SLOT_WINDOW_START_HOUR, 0).getTime();
			start + SLOT_MINUTES * 60_000 <= dayEnd;
			start += SLOT_MINUTES * 60_000
		) {
			const end = start + SLOT_MINUTES * 60_000
			if (start < earliest) continue
			if (blocks.some((b) => b.start < end && b.end > start)) continue
			slots.push({ start_iso: new Date(start).toISOString(), end_iso: new Date(end).toISOString() })
			break
		}
	}
	return slots
}
