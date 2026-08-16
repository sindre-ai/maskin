/**
 * PostHog HTTP capture for the quota poller.
 *
 * Emits `quota_alert_fired` events via direct POST to the PostHog capture
 * endpoint — zero dependencies (no `posthog-node` import) to match the
 * poller's standalone design. Fail-open: any HTTP or network error is logged
 * and swallowed so telemetry can never block a poll.
 */

import { randomUUID } from 'node:crypto'
import { env } from 'node:process'

/* -------------------------------------------------------------------------- */
/*  Logger — mirrors poller.ts's structured JSON format                       */
/* -------------------------------------------------------------------------- */

function logJson(level: 'info' | 'error', msg: string, context?: Record<string, unknown>) {
	const entry = { level, msg, timestamp: new Date().toISOString(), ...context }
	const output = JSON.stringify(entry)
	if (level === 'error') {
		console.error(output)
	} else {
		console.log(output)
	}
}

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const POSTHOG_HOST = env.POSTHOG_HOST || 'https://eu.i.posthog.com'
const CAPTURE_PATH = '/capture/'
const CAPTURE_TIMEOUT_MS = 10_000

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shape read from a poll's `quotas` map. Kept local to avoid a
 * circular import back into `poller.ts`.
 */
interface QuotaLike {
	headroom_pct: number | null
	reset_at?: string | null
}

export interface CaptureQuotaAlertsInput {
	quotas: Record<string, QuotaLike>
	thresholdPct: number
	pollTimestamp: string
	pollerRunId: string
	apiKey: string | undefined
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Generate a unique id per poller run. Used as the `poller_run_id` property
 * on every `quota_alert_fired` event emitted in that run so downstream
 * analysis can dedup or join events from the same tick.
 */
export function generatePollerRunId(): string {
	return randomUUID()
}

/**
 * Emit one `quota_alert_fired` event per route in `quotas`. Skipped entirely
 * when `apiKey` is unset (local dev, CI without the secret configured).
 *
 * AC-U1 — event shape:
 *   { route, headroom_pct, threshold_pct, reset_at, poll_timestamp,
 *     poller_run_id, source: 'quota_poller' }
 *
 * AC-T1 — routes with invalid provider keys never populate `quotas`, so no
 * event is emitted for them.
 */
export async function captureQuotaAlerts(input: CaptureQuotaAlertsInput): Promise<void> {
	if (!input.apiKey) return
	const routes = Object.entries(input.quotas)
	if (routes.length === 0) return

	const apiKey = input.apiKey
	await Promise.all(
		routes.map(([route, entry]) =>
			captureQuotaAlert({
				apiKey,
				route,
				headroomPct: entry.headroom_pct,
				thresholdPct: input.thresholdPct,
				resetAt: entry.reset_at ?? null,
				pollTimestamp: input.pollTimestamp,
				pollerRunId: input.pollerRunId,
			}),
		),
	)
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

interface CaptureQuotaAlertInput {
	apiKey: string
	route: string
	headroomPct: number | null
	thresholdPct: number
	resetAt: string | null
	pollTimestamp: string
	pollerRunId: string
}

async function captureQuotaAlert(input: CaptureQuotaAlertInput): Promise<void> {
	const url = `${POSTHOG_HOST}${CAPTURE_PATH}`
	const payload = {
		api_key: input.apiKey,
		event: 'quota_alert_fired',
		distinct_id: `quota_poller:${input.route}`,
		timestamp: input.pollTimestamp,
		properties: {
			route: input.route,
			headroom_pct: input.headroomPct,
			threshold_pct: input.thresholdPct,
			reset_at: input.resetAt,
			poll_timestamp: input.pollTimestamp,
			poller_run_id: input.pollerRunId,
			source: 'quota_poller',
			// Backend event keyed by route, not by an identified user. Without
			// this flag PostHog would create one Person profile per distinct_id
			// on every 5-minute tick — unbounded growth that inflates MAU-based
			// billing and degrades queries at exactly the scale this bet needs
			// to work.
			$process_person_profile: false,
		},
	}

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
		})
		if (!response.ok) {
			const body = await response.text().catch(() => '')
			logJson('error', 'PostHog capture returned non-OK', {
				route: input.route,
				status: response.status,
				status_text: response.statusText,
				body: body.slice(0, 300),
			})
		}
	} catch (err) {
		logJson('error', 'PostHog capture failed', {
			route: input.route,
			error: String(err),
			error_type: 'network',
		})
	}
}
