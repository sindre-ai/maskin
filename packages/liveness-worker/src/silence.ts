import type { HeartbeatResult } from './heartbeat'

/**
 * Evaluate silence given a heartbeat result and a threshold. The rule:
 *
 *   silent = threshold-exceeded  OR  non-2xx  OR  network-error  OR  null latest
 *
 * The active-hours gate is applied *outside* this function — silence is a
 * property of the heartbeat, and only pages if it falls in the on-call window.
 */

export type SilenceVerdict =
	| { silent: false }
	| {
			silent: true
			reason: SilenceReason
			minutes_since: number | null
			latest_completed_at: string | null
			status?: number
			error_message?: string
	  }

export type SilenceReason =
	| 'threshold_exceeded'
	| 'null_latest'
	| 'non_2xx'
	| 'network_error'
	| 'malformed'

export function evaluateSilence(hb: HeartbeatResult, thresholdMinutes: number): SilenceVerdict {
	if (hb.kind === 'network_error') {
		return {
			silent: true,
			reason: 'network_error',
			minutes_since: null,
			latest_completed_at: null,
			error_message: hb.message,
		}
	}
	if (hb.kind === 'non_2xx') {
		return {
			silent: true,
			reason: 'non_2xx',
			minutes_since: null,
			latest_completed_at: null,
			status: hb.status,
		}
	}
	if (hb.kind === 'malformed') {
		return {
			silent: true,
			reason: 'malformed',
			minutes_since: null,
			latest_completed_at: null,
			status: hb.status,
		}
	}

	const { minutes_since, latest_completed_at } = hb.body

	// Null latest = the sessions table is empty per T1. Worker treats null as
	// silence per the DoD — a fleet that has never completed a session is
	// indistinguishable from one that stopped.
	if (minutes_since === null || latest_completed_at === null) {
		return {
			silent: true,
			reason: 'null_latest',
			minutes_since: null,
			latest_completed_at: null,
		}
	}
	if (minutes_since > thresholdMinutes) {
		return {
			silent: true,
			reason: 'threshold_exceeded',
			minutes_since,
			latest_completed_at,
		}
	}
	return { silent: false }
}
