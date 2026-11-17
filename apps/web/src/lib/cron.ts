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
	const h = Number(hour ?? 9)
	const m = Number(minute ?? 0)
	return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
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

const COPENHAGEN_TIME_ZONE = 'Europe/Copenhagen'

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

/** The instant a Copenhagen wall-clock time falls on, summer and winter time included. */
function copenhagenWallTimeToInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): Date {
	const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute)
	// Two passes settle the offset when the guess lands on the other side of a clock change.
	let instant = wallAsUtc
	for (let i = 0; i < 2; i++) {
		const at = copenhagenParts(new Date(instant))
		const [h, m] = at.time.split(':').map(Number)
		const shown = Date.UTC(at.year, at.month - 1, at.day, h, m)
		instant -= shown - wallAsUtc
	}
	return new Date(instant)
}

/** The schedule fields a person picks in the trigger form. The hour, day of week and day
 * of month are Copenhagen time. */
export type CronPickerFields = Pick<
	ParsedCron,
	'frequency' | 'minute' | 'hour' | 'dayOfWeek' | 'dayOfMonth'
>

/** The next time the Copenhagen wall-clock schedule in `picked` fires, strictly after `now`. */
function nextCopenhagenFire(picked: CronPickerFields, now: Date): Date | null {
	const hour = Number(picked.hour)
	const minute = Number(picked.minute)
	const today = copenhagenParts(now)
	switch (picked.frequency) {
		case 'hourly':
			return null
		case 'daily':
		case 'weekly': {
			for (let offset = 0; offset <= 7; offset++) {
				const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
				if (picked.frequency === 'weekly' && day.getUTCDay() !== Number(picked.dayOfWeek)) continue
				const candidate = copenhagenWallTimeToInstant(
					day.getUTCFullYear(),
					day.getUTCMonth() + 1,
					day.getUTCDate(),
					hour,
					minute,
				)
				if (candidate > now) return candidate
			}
			return null
		}
		case 'monthly': {
			const dayOfMonth = Number(picked.dayOfMonth)
			// Months without that day (31st) are skipped; 24 months always reaches one.
			for (let offset = 0; offset < 24; offset++) {
				const first = new Date(Date.UTC(today.year, today.month - 1 + offset, 1))
				const year = first.getUTCFullYear()
				const month = first.getUTCMonth() + 1
				if (new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCMonth() !== month - 1) continue
				const candidate = copenhagenWallTimeToInstant(year, month, dayOfMonth, hour, minute)
				if (candidate > now) return candidate
			}
			return null
		}
	}
}

/** The cron expression (UTC, the zone the server runs every schedule in) for what a person
 * picked in Copenhagen time. Uses the next firing so summer and winter time are right.
 * Hourly has no hour to convert, since the two zones differ by whole hours. */
export function copenhagenPickerToCron(picked: CronPickerFields, now: Date = new Date()): string {
	const next = nextCopenhagenFire(picked, now)
	if (!next) return `${picked.minute} * * * *`
	const minute = next.getUTCMinutes()
	const hour = next.getUTCHours()
	switch (picked.frequency) {
		case 'daily':
			return `${minute} ${hour} * * *`
		case 'weekly':
			return `${minute} ${hour} * * ${next.getUTCDay()}`
		case 'monthly':
			return `${minute} ${hour} ${next.getUTCDate()} * *`
		default:
			return `${picked.minute} * * * *`
	}
}

/** The Copenhagen hour, weekday and day of month a cron expression (UTC) shows in the trigger
 * form picker. This is the same next firing `describeCronExpression` reads, so the form and
 * the list agree. `null` for anything `parseCronExpression` rejects. */
export function cronToCopenhagenPicker(expr: string, now: Date = new Date()): ParsedCron | null {
	const parsed = parseCronExpression(expr)
	if (!parsed) return null
	if (parsed.frequency === 'hourly') return parsed
	const next = nextCronFire(expr, now)
	if (!next) return parsed
	const at = copenhagenParts(next)
	const [hour, minute] = at.time.split(':').map(Number)
	const dayOfWeek = Object.keys(DAY_NAMES).find((k) => DAY_NAMES[k] === at.weekday)
	return {
		frequency: parsed.frequency,
		hour: String(hour),
		minute: String(minute),
		dayOfWeek: parsed.frequency === 'weekly' && dayOfWeek ? dayOfWeek : parsed.dayOfWeek,
		dayOfMonth: parsed.frequency === 'monthly' ? String(at.day) : parsed.dayOfMonth,
	}
}
