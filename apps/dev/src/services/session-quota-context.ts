import type { SessionResultFailureReason } from '@maskin/shared'

/**
 * Route bucket the quota-wall-alarm bet already uses on its own
 * `quota_alert_fired` events (`scripts/quota-poller/poller.ts`). Keep the
 * three-string enum in lockstep so the PostHog cohort join in AC-T3 pairs
 * `agent_session_completed` back to the poller's alerts on `route` +
 * `error_code` within a 4-hour window.
 */
export type QuotaRoute = 'openrouter' | 'claude_weekly' | 'claude_5h_overage'

/**
 * `error_code` values the AC-T3 PostHog query filters on. The bet's success
 * metric reads `error_code IN ('HTTP_402','HTTP_429')`, so we only surface
 * those two shapes from the classifier — everything else stays `null` so it
 * doesn't accidentally count as a quota-driven failure.
 */
export type QuotaErrorCode = 'HTTP_402' | 'HTTP_429'

export interface QuotaContext {
	route: QuotaRoute | null
	error_code: QuotaErrorCode | null
}

const CLAUDE_WEEKLY_REASONS = new Set<string>(['weekly_limit'])

/**
 * Map a classified failure reason (from `lib/credit-classifier.ts`) onto the
 * `{ route, error_code }` pair the AC-T3 query needs.
 *
 * `null` for either side is the safe default — an unclassifiable failure, or a
 * completion that never carried a failure reason (successful exit, timeout,
 * enqueue error), simply gets `{ route: null, error_code: null }` on the
 * PostHog event and is naturally excluded from the quota-driven cohort.
 */
export function deriveQuotaContext(failureReason: SessionResultFailureReason | null): QuotaContext {
	if (!failureReason) return { route: null, error_code: null }

	let route: QuotaRoute | null = null
	if (failureReason.provider === 'openrouter') {
		route = 'openrouter'
	} else if (failureReason.provider === 'anthropic') {
		route = CLAUDE_WEEKLY_REASONS.has(failureReason.reason_code)
			? 'claude_weekly'
			: 'claude_5h_overage'
	}

	let error_code: QuotaErrorCode | null = null
	if (failureReason.http_status === 402) error_code = 'HTTP_402'
	else if (failureReason.http_status === 429) error_code = 'HTTP_429'

	return { route, error_code }
}
