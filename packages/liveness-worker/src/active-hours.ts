/**
 * Decide whether `now` falls inside the active-hours window in a given IANA
 * timezone. We resolve the local time via `Intl.DateTimeFormat` so DST is
 * handled by the runtime — never by us — and there is no hardcoded UTC offset.
 * The window is closed-open: [start, end).
 */

export type HourMinute = { hour: number; minute: number }

export type ActiveHoursWindow = {
	start: HourMinute
	end: HourMinute
	timezone: string
}

const HHMM = /^(\d{1,2}):(\d{2})$/

function parseHHMM(s: string): HourMinute {
	const m = HHMM.exec(s.trim())
	if (!m) throw new Error(`Invalid HH:MM: "${s}"`)
	const hour = Number(m[1])
	const minute = Number(m[2])
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error(`HH:MM out of range: "${s}"`)
	}
	return { hour, minute }
}

/**
 * Parse an ACTIVE_HOURS string like "07:00-23:00". The ASCII hyphen is the
 * canonical separator; we also accept the en-dash the ADR uses in prose.
 */
export function parseActiveHours(spec: string, timezone: string): ActiveHoursWindow {
	const normalized = spec.replace(/[\u2013\u2014]/g, '-') // en/em-dash → hyphen
	const parts = normalized.split('-')
	if (parts.length !== 2) {
		throw new Error(`ACTIVE_HOURS must be "HH:MM-HH:MM", got: "${spec}"`)
	}
	return {
		start: parseHHMM(parts[0] as string),
		end: parseHHMM(parts[1] as string),
		timezone,
	}
}

/**
 * Return the local hour/minute for `at` in `timezone`, resolved via
 * `Intl.DateTimeFormat`. This is the only place we ask the runtime to do the
 * UTC→local translation, and it's DST-aware because Intl consults tzdata.
 */
export function localHourMinute(at: Date, timezone: string): HourMinute {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
	})
	// `en-GB` with `hour12: false` renders 00–23 (never 24). Parse rather than
	// trust field order, which locale updates have shifted before.
	const parts = fmt.formatToParts(at)
	let hour = -1
	let minute = -1
	for (const p of parts) {
		if (p.type === 'hour') hour = Number(p.value)
		else if (p.type === 'minute') minute = Number(p.value)
	}
	if (hour < 0 || minute < 0) {
		throw new Error(`Could not extract hour/minute from Intl output for tz ${timezone}`)
	}
	return { hour: hour === 24 ? 0 : hour, minute }
}

function toMinutes(hm: HourMinute): number {
	return hm.hour * 60 + hm.minute
}

/**
 * True iff `at` falls in [start, end) of `window.timezone`. Windows that
 * wrap midnight (end <= start) are supported; we don't use one today but the
 * cost is a single extra branch.
 */
export function isWithinActiveHours(at: Date, window: ActiveHoursWindow): boolean {
	const nowMin = toMinutes(localHourMinute(at, window.timezone))
	const startMin = toMinutes(window.start)
	const endMin = toMinutes(window.end)
	if (startMin === endMin) return false
	if (startMin < endMin) return nowMin >= startMin && nowMin < endMin
	return nowMin >= startMin || nowMin < endMin
}
