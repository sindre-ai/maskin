import type { ErrorEvent } from '@sentry/node'

// The five messages that made 82% of the stored errors from 20 to 29 Oct 2026
// and used up the free Sentry quota. Each is reported with captureMessage, so
// event.message is the issue title; titles stay unchanged so alert rules on
// them keep matching. Everything else passes through untouched.
export const NOISY_MESSAGES: ReadonlySet<string> = new Set([
	'Conversation auto-title failed',
	'Claude OAuth token refresh failed',
	'Session dispatch permanent failure',
	'Failed to build agent-base image — sessions will fail until image is available',
	'Claude session died on a 401',
])

export const DEDUPE_WINDOW_MS = 60 * 60 * 1000
// Keys are message x workspace, so this is only a backstop against unbounded growth.
const PRUNE_ABOVE = 1000

function workspaceIdOf(event: ErrorEvent): string {
	const tags = event.tags ?? {}
	const extra = event.extra ?? {}
	const id = tags.workspace_id ?? tags.workspaceId ?? extra.workspaceId
	return typeof id === 'string' ? id : ''
}

/**
 * beforeSend step: lets the first event per (message, workspace id) through and
 * drops repeats until the window has passed since the last one that was sent.
 * Events without a workspace id share one key per message.
 */
export function createSentryDedupe(windowMs = DEDUPE_WINDOW_MS, now: () => number = Date.now) {
	const lastSent = new Map<string, number>()
	return function dedupe(event: ErrorEvent): ErrorEvent | null {
		const message = event.message
		if (message === undefined || !NOISY_MESSAGES.has(message)) return event
		const key = `${message}\u0000${workspaceIdOf(event)}`
		const at = now()
		const prev = lastSent.get(key)
		if (prev !== undefined && at - prev < windowMs) return null
		if (lastSent.size >= PRUNE_ABOVE) {
			for (const [k, t] of lastSent) if (at - t >= windowMs) lastSent.delete(k)
		}
		lastSent.set(key, at)
		return event
	}
}
