// Europe/Copenhagen calendar math for the voice retry schedule. No dependency:
// Intl does the zone work. Weekends are the only non-workdays modelled; Danish
// public holidays are not (the dialer's own time-of-day gate is the backstop).

const TZ = 'Europe/Copenhagen'
export const DIAL_WINDOW_START_HOUR = 9
export const DIAL_WINDOW_END_HOUR = 16

const partsFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: TZ,
	hourCycle: 'h23',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
})

export interface LocalParts {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	second: number
}

export function copenhagenParts(date: Date): LocalParts {
	const out: Record<string, number> = {}
	for (const p of partsFormat.formatToParts(date)) {
		if (p.type !== 'literal') out[p.type] = Number(p.value)
	}
	return {
		year: out.year as number,
		month: out.month as number,
		day: out.day as number,
		hour: out.hour as number,
		minute: out.minute as number,
		second: out.second as number,
	}
}

/** YYYY-MM-DD of the Copenhagen calendar day containing `date`. */
export function copenhagenDay(date: Date): string {
	const p = copenhagenParts(date)
	return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function offsetMs(at: Date): number {
	const p = copenhagenParts(at)
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime()
}

/** The UTC instant at which Copenhagen wall-clock reads year-month-day hour:minute. */
export function copenhagenToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second = 0,
): Date {
	const guess = Date.UTC(year, month - 1, day, hour, minute, second)
	let result = guess - offsetMs(new Date(guess))
	// Second pass settles instants that straddle a DST change.
	result = guess - offsetMs(new Date(result))
	return new Date(result)
}

function isWeekend(year: number, month: number, day: number): boolean {
	const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
	return dow === 0 || dow === 6
}

function addCalendarDays(
	year: number,
	month: number,
	day: number,
	n: number,
): { year: number; month: number; day: number } {
	const d = new Date(Date.UTC(year, month - 1, day + n))
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function nextWorkday(d: { year: number; month: number; day: number }) {
	let next = addCalendarDays(d.year, d.month, d.day, 1)
	while (isWeekend(next.year, next.month, next.day)) {
		next = addCalendarDays(next.year, next.month, next.day, 1)
	}
	return next
}

/**
 * now + n workdays, landing inside the 09:00-16:00 Copenhagen dial window on the
 * target day: the same wall-clock time when that is already inside the window,
 * otherwise 09:00 (too early) or 09:00 on the following workday (16:00 or later).
 */
export function addWorkdays(now: Date, n: number): Date {
	const p = copenhagenParts(now)
	let day = { year: p.year, month: p.month, day: p.day }
	for (let i = 0; i < n; i++) day = nextWorkday(day)

	if (p.hour < DIAL_WINDOW_START_HOUR) {
		return copenhagenToUtc(day.year, day.month, day.day, DIAL_WINDOW_START_HOUR, 0)
	}
	if (p.hour >= DIAL_WINDOW_END_HOUR) {
		const after = nextWorkday(day)
		return copenhagenToUtc(after.year, after.month, after.day, DIAL_WINDOW_START_HOUR, 0)
	}
	return copenhagenToUtc(day.year, day.month, day.day, p.hour, p.minute, p.second)
}
