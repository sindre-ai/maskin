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

function isSimpleField(field: string | undefined): field is string {
	return field === '*' || /^\d+$/.test(field ?? '')
}

/** Standard 5-field cron (minute hour dayOfMonth month dayOfWeek) — month is
 * always `*` for the schedules this app generates, so it's parsed but unused.
 * A leading seconds field (6-field cron) is tolerated and dropped. Returns
 * `null` for anything this app doesn't generate itself — step syntax, lists
 * (`9,15`), ranges (`1-5`), day names (`MON`) — so callers can fall back to
 * showing the raw expression instead of a confidently wrong one. */
export function parseCronExpression(expr: string): ParsedCron | null {
	const parts = expr.trim().split(/\s+/)
	const fields = parts.length === 6 ? parts.slice(1) : parts
	if (fields.length !== 5) return null
	const [minute, hour, dayOfMonth, , dayOfWeek] = fields
	if (![minute, hour, dayOfMonth, dayOfWeek].every(isSimpleField)) return null

	if (dayOfWeek !== '*') return { frequency: 'weekly', minute, hour, dayOfWeek, dayOfMonth: '1' }
	if (dayOfMonth !== '*') return { frequency: 'monthly', minute, hour, dayOfWeek: '1', dayOfMonth }
	if (hour !== '*') return { frequency: 'daily', minute, hour, dayOfWeek: '1', dayOfMonth: '1' }
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
