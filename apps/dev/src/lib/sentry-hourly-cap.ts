import type { ErrorEvent } from '@sentry/node'

// The maskin-dev Sentry quota (5,000 a month) ran out on 21 Nov 2026 and the plan has no
// per-key rate limit, so the app caps itself. To remove the cap, delete the
// createSentryHourlyCap() step from beforeSend in sentry.ts (and this file).
export const HOURLY_EVENT_CAP = 8
// Warnings and below may use half the hour's budget, so a burst of low-severity events cannot
// use up the room that errors and fatals need.
export const LOW_SEVERITY_CAP = 4
export const HOURLY_CAP_WINDOW_MS = 60 * 60 * 1000

/**
 * beforeSend step: lets at most HOURLY_EVENT_CAP events through in any rolling hour and drops the
 * rest. Errors and fatals (and events with no level, which Sentry treats as errors) may use the
 * whole budget; lower levels stop at LOW_SEVERITY_CAP. Dropped events do not count.
 */
export function createSentryHourlyCap(
	cap = HOURLY_EVENT_CAP,
	lowSeverityCap = LOW_SEVERITY_CAP,
	windowMs = HOURLY_CAP_WINDOW_MS,
	now: () => number = Date.now,
) {
	let sent: number[] = []
	return function limit(event: ErrorEvent): ErrorEvent | null {
		const at = now()
		sent = sent.filter((t) => at - t < windowMs)
		const severe = event.level === undefined || event.level === 'error' || event.level === 'fatal'
		if (sent.length >= (severe ? cap : lowSeverityCap)) return null
		sent.push(at)
		return event
	}
}
