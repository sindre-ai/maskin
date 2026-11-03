/**
 * Wall-clock helpers for per-actor schedules. Pure and total: an invalid or unknown IANA
 * timezone yields `null` instead of throwing, so one actor's bad stored value can never fail
 * a scheduler tick. There is deliberately NO UTC fallback here: callers that schedule in an
 * actor's local time must skip an actor whose timezone they cannot resolve rather than guess.
 */

export interface LocalClock {
	/** Local calendar date, `YYYY-MM-DD`. */
	date: string
	/** Minutes since local midnight, 0-1439. */
	minute: number
}

export function localClock(at: Date, timezone: string): LocalClock | null {
	if (!timezone || Number.isNaN(at.getTime())) return null
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		}).formatToParts(at)
		const get = (type: string) => parts.find((p) => p.type === type)?.value
		const year = Number(get('year'))
		const month = Number(get('month'))
		const day = Number(get('day'))
		const hour = Number(get('hour'))
		const minute = Number(get('minute'))
		if (![year, month, day, hour, minute].every(Number.isFinite)) return null
		const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
		return { date, minute: (hour % 24) * 60 + minute }
	} catch {
		return null
	}
}

/**
 * Has the actor's local time reached `targetMinute` today, but by no more than `windowMinutes`?
 * The window stops a scheduler that was down (or an actor who just switched the briefing on)
 * from firing a "morning" push in the evening. Works on the *local* clock, so a DST jump that
 * skips the target minute (02:30 on a spring-forward day) still fires at the first minute after
 * it, and a repeated hour (fall back) is harmless because the day is claimed once.
 */
export function localTimeReached(
	at: Date,
	timezone: string,
	targetMinute: number,
	windowMinutes: number,
): LocalClock | null {
	const clock = localClock(at, timezone)
	if (!clock) return null
	if (clock.minute < targetMinute || clock.minute >= targetMinute + windowMinutes) return null
	return clock
}
