// Stored times are UTC ISO strings. A tool result that carries one also carries the same moment
// in the caller's zone, so an agent never has to convert (or guess) before it tells a person.

/** The zone agents run in and speak in when no person's zone is known. */
export const DEFAULT_TIMEZONE = 'Europe/Copenhagen'

/** "Tue 17 Nov 2026, 16:25 (Europe/Copenhagen)". Null when `iso` is not a time or the zone is unknown. */
export function formatLocalTime(iso: string | null | undefined, timezone: string): string | null {
	if (!iso) return null
	const at = new Date(iso)
	if (Number.isNaN(at.getTime())) return null
	try {
		const parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: timezone,
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(at)
		const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
		return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} (${timezone})`
	} catch {
		return null
	}
}

/** `row` plus a `<key>_local` next to each listed key that holds a time. Other keys are untouched. */
export function withLocalTimes<T extends object>(
	row: T,
	keys: readonly string[],
	timezone: string,
): T & Record<string, unknown> {
	const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
	for (const key of keys) {
		const value = out[key]
		const local = typeof value === 'string' ? formatLocalTime(value, timezone) : null
		if (local) out[`${key}_local`] = local
	}
	return out as T & Record<string, unknown>
}
