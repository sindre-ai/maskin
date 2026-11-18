export type CronFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface ParsedCron {
	frequency: CronFrequency
	minute: string
	hour: string
	dayOfWeek: string
	dayOfMonth: string
}

const DAY_NAMES: Record<string, string> = {
	'0': 'Sunday',
	'1': 'Monday',
	'2': 'Tuesday',
	'3': 'Wednesday',
	'4': 'Thursday',
	'5': 'Friday',
	'6': 'Saturday',
}

function isFieldInRange(field: string | undefined, min: number, max: number): field is string {
	if (field === undefined || !/^\d+$/.test(field)) return false
	const n = Number(field)
	return n >= min && n <= max
}

function isValidOrWildcard(field: string | undefined, min: number, max: number): field is string {
	return field === '*' || isFieldInRange(field, min, max)
}

/** Standard 5-field cron (minute hour dayOfMonth month dayOfWeek). A leading
 * seconds field (6-field cron) is tolerated and dropped. Returns `null` for
 * anything this app doesn't generate itself — a restricted month field, an
 * out-of-range field, step syntax, lists (`9,15`), ranges (`1-5`), day names
 * (`MON`) — so callers can fall back to showing the raw expression instead of
 * a confidently wrong one. */
export function parseCronExpression(expr: string): ParsedCron | null {
	const parts = expr.trim().split(/\s+/)
	const fields = parts.length === 6 ? parts.slice(1) : parts
	if (fields.length !== 5) return null
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
	if (month !== '*') return null
	if (!isValidOrWildcard(minute, 0, 59)) return null
	if (!isValidOrWildcard(hour, 0, 23)) return null
	if (!isValidOrWildcard(dayOfMonth, 1, 31)) return null
	if (!isValidOrWildcard(dayOfWeek, 0, 7)) return null
	const normalizedDayOfWeek = dayOfWeek === '7' ? '0' : dayOfWeek

	// A wildcard hour/minute makes the schedule fire more than once within the
	// bucket implied by the other fields (e.g. every minute on Sundays) — this
	// app never generates that, so fall back rather than guess a time.
	if (normalizedDayOfWeek !== '*') {
		if (hour === '*' || minute === '*') return null
		return { frequency: 'weekly', minute, hour, dayOfWeek: normalizedDayOfWeek, dayOfMonth: '1' }
	}
	if (dayOfMonth !== '*') {
		if (hour === '*' || minute === '*') return null
		return { frequency: 'monthly', minute, hour, dayOfWeek: '1', dayOfMonth }
	}
	if (hour !== '*') {
		if (minute === '*') return null
		return { frequency: 'daily', minute, hour, dayOfWeek: '1', dayOfMonth: '1' }
	}
	if (minute === '*') return null
	return { frequency: 'hourly', minute, hour: '9', dayOfWeek: '1', dayOfMonth: '1' }
}

function formatTime(hour: string, minute: string): string {
	return `${String(Number(hour ?? 9)).padStart(2, '0')}:${String(Number(minute ?? 0)).padStart(2, '0')}`
}

export function describeCronSchedule(parsed: ParsedCron): string {
	const timeStr = formatTime(parsed.hour, parsed.minute)
	switch (parsed.frequency) {
		case 'hourly':
			return `every hour at minute ${Number(parsed.minute ?? 0)}`
		case 'daily':
			return `every day at ${timeStr}`
		case 'weekly':
			return `every ${DAY_NAMES[parsed.dayOfWeek] ?? 'Monday'} at ${timeStr}`
		case 'monthly':
			return `on day ${parsed.dayOfMonth} of each month at ${timeStr}`
	}
}

export const COPENHAGEN_TIME_ZONE = 'Europe/Copenhagen'

const MONTH_NAMES = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
]

const copenhagenFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: COPENHAGEN_TIME_ZONE,
	hourCycle: 'h23',
	year: 'numeric',
	month: 'numeric',
	day: 'numeric',
	weekday: 'long',
	hour: '2-digit',
	minute: '2-digit',
})

export interface CopenhagenParts {
	year: number
	month: number
	day: number
	weekday: string
	/** 24-hour `HH:MM`. */
	time: string
}

/** The wall-clock parts of an instant in Copenhagen, summer and winter time included. */
export function copenhagenParts(date: Date): CopenhagenParts {
	const parts: Record<string, string> = {}
	for (const part of copenhagenFormat.formatToParts(date)) parts[part.type] = part.value
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		weekday: parts.weekday ?? '',
		time: `${parts.hour}:${parts.minute}`,
	}
}

/** `3 Nov at 09:00` in Copenhagen time. The year is added only when it is not the current one. */
export function describeCopenhagenDateTime(date: Date, now: Date = new Date()): string {
	const at = copenhagenParts(date)
	const year = at.year === copenhagenParts(now).year ? '' : ` ${at.year}`
	return `${at.day} ${MONTH_NAMES[at.month - 1]}${year} at ${at.time}`
}

/** A fixed day and month, e.g. `0 8 3 11 *`. The app treats it as a one-time date. */
interface OneTimeCron {
	minute: number
	hour: number
	dayOfMonth: number
	month: number
}

function parseOneTimeCron(expr: string): OneTimeCron | null {
	const parts = expr.trim().split(/\s+/)
	const fields = parts.length === 6 ? parts.slice(1) : parts
	if (fields.length !== 5) return null
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
	if (dayOfWeek !== '*') return null
	if (!isFieldInRange(minute, 0, 59)) return null
	if (!isFieldInRange(hour, 0, 23)) return null
	if (!isFieldInRange(dayOfMonth, 1, 31)) return null
	if (!isFieldInRange(month, 1, 12)) return null
	return {
		minute: Number(minute),
		hour: Number(hour),
		dayOfMonth: Number(dayOfMonth),
		month: Number(month),
	}
}

/** Next instant strictly after `from` for a one-time cron. Looks a few years ahead so
 * 29 Feb still resolves; `null` for a date that never exists (31 Nov). */
function nextOneTimeFire(cron: OneTimeCron, from: Date): Date | null {
	const year = from.getUTCFullYear()
	for (let y = year; y <= year + 8; y++) {
		const candidate = new Date(Date.UTC(y, cron.month - 1, cron.dayOfMonth, cron.hour, cron.minute))
		if (candidate.getUTCMonth() !== cron.month - 1) continue
		if (candidate > from) return candidate
	}
	return null
}

/** Human-readable schedule from a raw cron expression, e.g. "0 17 * * 0" -> "every Sunday at 18:00".
 * The server runs every schedule in UTC, so times are converted to Copenhagen time (24-hour),
 * using the next firing so summer and winter time are right. A weekly or monthly schedule can
 * land on another day after the conversion; the weekday or day number follows it.
 * Falls back to the raw expression when it uses syntax this app doesn't generate itself
 * (steps, lists, ranges, day names) rather than rendering a wrong description. */
export function describeCronExpression(expr: string, now: Date = new Date()): string {
	const parsed = parseCronExpression(expr)
	if (parsed) {
		if (parsed.frequency === 'hourly') return describeCronSchedule(parsed)
		const next = nextCronFire(expr, now)
		if (!next) return expr
		const at = copenhagenParts(next)
		switch (parsed.frequency) {
			case 'daily':
				return `every day at ${at.time}`
			case 'weekly':
				return `every ${at.weekday} at ${at.time}`
			case 'monthly':
				return `on day ${at.day} of each month at ${at.time}`
		}
	}
	const oneTime = parseOneTimeCron(expr)
	if (oneTime) {
		const next = nextOneTimeFire(oneTime, now)
		if (!next) return expr
		return `once on ${describeCopenhagenDateTime(next, now)}`
	}
	return expr
}

/** Next firing instant strictly after `from` for a cron expression this app
 * generates itself. Fields are read in UTC, the zone the server runs every
 * schedule in. Also handles a fixed day and month (a one-time date). Returns
 * `null` for any other expression `parseCronExpression` rejects (steps, lists,
 * ranges, day names, out-of-range fields) so the caller can fall through to a
 * `—` rather than guessing a time. */
export function nextCronFire(expr: string, from: Date = new Date()): Date | null {
	const parsed = parseCronExpression(expr)
	if (!parsed) {
		const oneTime = parseOneTimeCron(expr)
		return oneTime ? nextOneTimeFire(oneTime, from) : null
	}
	const minute = Number(parsed.minute === '*' ? 0 : parsed.minute)
	const hour = Number(parsed.hour === '*' ? 0 : parsed.hour)

	switch (parsed.frequency) {
		case 'hourly': {
			const next = new Date(from)
			next.setUTCSeconds(0, 0)
			next.setUTCMinutes(minute)
			if (next <= from) next.setUTCHours(next.getUTCHours() + 1)
			return next
		}
		case 'daily': {
			const next = new Date(from)
			next.setUTCSeconds(0, 0)
			next.setUTCHours(hour, minute)
			if (next <= from) next.setUTCDate(next.getUTCDate() + 1)
			return next
		}
		case 'weekly': {
			const targetDow = Number(parsed.dayOfWeek)
			const next = new Date(from)
			next.setUTCSeconds(0, 0)
			next.setUTCHours(hour, minute)
			// Positive modulo — a same-day fire that's already past pushes to
			// next week, not today.
			const dayGap = (targetDow - next.getUTCDay() + 7) % 7
			if (dayGap === 0 && next <= from) next.setUTCDate(next.getUTCDate() + 7)
			else next.setUTCDate(next.getUTCDate() + dayGap)
			return next
		}
		case 'monthly': {
			const targetDom = Number(parsed.dayOfMonth)
			const next = new Date(from)
			next.setUTCSeconds(0, 0)
			next.setUTCDate(targetDom)
			next.setUTCHours(hour, minute)
			// setDate can overflow (e.g. day 31 in a 30-day month) — that's the
			// wrong answer for the current month, so advance one calendar
			// month and re-apply until the day sticks.
			if (next.getUTCDate() !== targetDom || next <= from) {
				do {
					next.setUTCDate(1)
					next.setUTCMonth(next.getUTCMonth() + 1)
					next.setUTCDate(targetDom)
				} while (next.getUTCDate() !== targetDom)
			}
			return next
		}
	}
}

/** `2026-11-17 21:00` in Copenhagen time, for tool results. Null for anything that is not a date. */
export function formatCopenhagenStamp(value: string | Date): string | null {
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) return null
	const at = copenhagenParts(date)
	const two = (n: number) => String(n).padStart(2, '0')
	return `${at.year}-${two(at.month)}-${two(at.day)} ${at.time}`
}

/** Minutes Copenhagen is ahead of UTC at `at`: 60 in winter, 120 in summer. */
export function copenhagenOffsetMinutes(at: Date): number {
	const local = copenhagenParts(at)
	const asUtc = Date.UTC(local.year, local.month - 1, local.day, ...hourMinute(local.time))
	return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000)
}

function hourMinute(time: string): [number, number] {
	const [h, m] = time.split(':')
	return [Number(h), Number(m)]
}

/** The instant a Copenhagen wall-clock date (`YYYY-MM-DD`) and time (`HH:MM`) falls on. */
export function copenhagenWallToInstant(date: string, time: string): Date | null {
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
	const t = /^(\d{2}):(\d{2})$/.exec(time)
	if (!d || !t) return null
	const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
	// Try the winter offset, then check what Copenhagen says and correct once for summer time.
	let guess = new Date(wall - 60 * 60_000)
	guess = new Date(wall - copenhagenOffsetMinutes(guess) * 60_000)
	return Number.isNaN(guess.getTime()) ? null : guess
}

/** `YYYY-MM-DD` and `HH:MM` of an instant in Copenhagen, for the date and time inputs. */
export function copenhagenDateAndTime(date: Date): { date: string; time: string } {
	const at = copenhagenParts(date)
	const two = (n: number) => String(n).padStart(2, '0')
	return { date: `${at.year}-${two(at.month)}-${two(at.day)}`, time: at.time }
}

function shiftCron(parsed: ParsedCron, offsetMinutes: number): ParsedCron {
	if (parsed.frequency === 'hourly') return parsed
	const total = Number(parsed.hour) * 60 + Number(parsed.minute) + offsetMinutes
	const dayShift = Math.floor(total / 1440)
	const within = total - dayShift * 1440
	const hour = String(Math.floor(within / 60))
	const minute = String(within % 60)
	if (parsed.frequency === 'weekly') {
		const dow = (((Number(parsed.dayOfWeek) + dayShift) % 7) + 7) % 7
		return { ...parsed, hour, minute, dayOfWeek: String(dow) }
	}
	if (parsed.frequency === 'monthly') {
		const dom = Math.min(31, Math.max(1, Number(parsed.dayOfMonth) + dayShift))
		return { ...parsed, hour, minute, dayOfMonth: String(dom) }
	}
	return { ...parsed, hour, minute }
}

/** What the schedule form shows: the stored UTC schedule as Copenhagen wall-clock fields. */
export function cronUtcToCopenhagen(parsed: ParsedCron, now: Date = new Date()): ParsedCron {
	return shiftCron(parsed, copenhagenOffsetMinutes(now))
}

/** What the form stores: Copenhagen wall-clock fields back to the UTC schedule the server runs. */
export function cronCopenhagenToUtc(parsed: ParsedCron, now: Date = new Date()): ParsedCron {
	return shiftCron(parsed, -copenhagenOffsetMinutes(now))
}
