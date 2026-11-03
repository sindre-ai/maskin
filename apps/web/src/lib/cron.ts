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

/** Human-readable schedule from a raw cron expression, e.g. "0 17 * * 0" -> "every Sunday at 5:00 PM".
 * Falls back to the raw expression when it uses syntax this app doesn't generate itself
 * (steps, lists, ranges, day names) rather than rendering a wrong description. */
export function describeCronExpression(expr: string): string {
	const parsed = parseCronExpression(expr)
	return parsed ? describeCronSchedule(parsed) : expr
}

/** Next firing instant strictly after `from` for a cron expression this app
 * generates itself. Returns `null` for any expression `parseCronExpression`
 * rejects (steps, lists, ranges, day names, out-of-range fields) so the caller
 * can fall through to a `—` rather than guessing a time. */
export function nextCronFire(expr: string, from: Date = new Date()): Date | null {
	const parsed = parseCronExpression(expr)
	if (!parsed) return null
	const minute = Number(parsed.minute === '*' ? 0 : parsed.minute)
	const hour = Number(parsed.hour === '*' ? 0 : parsed.hour)

	switch (parsed.frequency) {
		case 'hourly': {
			const next = new Date(from)
			next.setSeconds(0, 0)
			next.setMinutes(minute)
			if (next <= from) next.setHours(next.getHours() + 1)
			return next
		}
		case 'daily': {
			const next = new Date(from)
			next.setSeconds(0, 0)
			next.setHours(hour, minute)
			if (next <= from) next.setDate(next.getDate() + 1)
			return next
		}
		case 'weekly': {
			const targetDow = Number(parsed.dayOfWeek)
			const next = new Date(from)
			next.setSeconds(0, 0)
			next.setHours(hour, minute)
			// Positive modulo — a same-day fire that's already past pushes to
			// next week, not today.
			const dayGap = (targetDow - next.getDay() + 7) % 7
			if (dayGap === 0 && next <= from) next.setDate(next.getDate() + 7)
			else next.setDate(next.getDate() + dayGap)
			return next
		}
		case 'monthly': {
			const targetDom = Number(parsed.dayOfMonth)
			const next = new Date(from)
			next.setSeconds(0, 0)
			next.setDate(targetDom)
			next.setHours(hour, minute)
			// setDate can overflow (e.g. day 31 in a 30-day month) — that's the
			// wrong answer for the current month, so advance one calendar
			// month and re-apply until the day sticks.
			if (next.getDate() !== targetDom || next <= from) {
				do {
					next.setDate(1)
					next.setMonth(next.getMonth() + 1)
					next.setDate(targetDom)
				} while (next.getDate() !== targetDom)
			}
			return next
		}
	}
}
