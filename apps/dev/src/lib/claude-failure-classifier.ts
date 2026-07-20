/**
 * Classifies a Claude subscription call failure into a failover decision.
 *
 * Pure function — no IO, no storage writes. T6 calls this at session start
 * after a failed primary call to decide whether to retry the primary or
 * fail over to the backup, and to record the classified reason on the
 * `claude_subscription_failover_triggered` event (AC-U2 / AC-T3).
 *
 * Reason codes are snake_case so they line up with the keys used by
 * `FAILOVER_REASON_COPY` in the workspace settings UI; T8's followup adds
 * a generic banner fallback for any reason not in that map.
 */

export type FailoverAction = 'failover' | 'retry_primary'

export type ClaudeFailureReason =
	| 'auth_failed'
	| 'quota_exhausted'
	| 'throughput_burst'
	| 'server_error'
	| 'network_timeout'

export interface ClassifierDecision {
	action: FailoverAction
	reason: ClaudeFailureReason
}

/** HTTP response observed from the Anthropic API call. */
export interface HttpFailureInput {
	kind: 'http'
	status: number
	/** Header lookup — case-insensitive, returns the raw header value or null. */
	headers: HeaderLookup
	/**
	 * Parsed JSON body, when the caller could read it. Optional because the
	 * probe may skip reading the body (e.g. on 5xx to avoid a slow drain) or
	 * fail to parse it. When present, the classifier scans it for the
	 * Anthropic `rate_limit_error` / `rate_limit_event` shape the Claude Code
	 * subscription surfaces when a 5-hour bucket is drained but the
	 * `anthropic-ratelimit-unified-status: exhausted` header is missing.
	 */
	body?: unknown
}

/** Transport-level failure (no HTTP response). */
export interface TransportFailureInput {
	kind: 'transport'
	error: 'timeout' | 'network'
}

export type ClassifierInput = HttpFailureInput | TransportFailureInput

/**
 * Minimal header reader the classifier needs. A `Headers` instance and a
 * plain record both work — see `headersFrom` below for the record adapter.
 */
export interface HeaderLookup {
	get(name: string): string | null
}

/**
 * Classify a Claude API call failure.
 *
 * Decision order on a 429:
 *  1. `anthropic-ratelimit-unified-status: exhausted` header — the documented
 *     quota-exhausted signal, always wins.
 *  2. Response body signals the Claude Code subscription surfaces when the
 *     5-hour bucket is drained (`type: rate_limit_error`, or a `rate_limit_event`
 *     with `overageStatus: "rejected"` / `rateLimitType: "five_hour"`). Same
 *     failover verdict as the header — a rate-limit rejection is
 *     structurally an OAuth-death-shaped outage for the primary slot, so
 *     without body inspection a bucket-exhaustion 429 with no exhausted
 *     header would silently retry the primary forever.
 *  3. Any other 429 (throughput burst, or no usable signal at all) retries
 *     the primary rather than failing over silently.
 */
export function classifyClaudeFailure(input: ClassifierInput): ClassifierDecision {
	if (input.kind === 'transport') {
		return { action: 'retry_primary', reason: 'network_timeout' }
	}

	const { status, headers, body } = input

	if (status === 401) {
		return { action: 'failover', reason: 'auth_failed' }
	}

	if (status === 429) {
		const unified = headers.get('anthropic-ratelimit-unified-status')
		if (unified?.trim().toLowerCase() === 'exhausted') {
			return { action: 'failover', reason: 'quota_exhausted' }
		}
		if (bodyIndicatesRateLimitRejection(body)) {
			return { action: 'failover', reason: 'quota_exhausted' }
		}
		return { action: 'retry_primary', reason: 'throughput_burst' }
	}

	if (status >= 500 && status <= 599) {
		return { action: 'retry_primary', reason: 'server_error' }
	}

	// Any other status (2xx, 3xx, 4xx besides 401/429) — caller shouldn't be
	// invoking the classifier on these, but default to retry to avoid an
	// unwarranted failover on a status we don't recognise.
	return { action: 'retry_primary', reason: 'server_error' }
}

/**
 * Scan a parsed 429 body for the Claude Code subscription rate-limit
 * rejection shape. Anthropic's HTTP surface wraps the failure as
 * `{ type: "error", error: { type: "rate_limit_error", message: ... } }`;
 * the Claude Code CLI additionally emits an inline `rate_limit_event`
 * with `rateLimitType` / `overageStatus` fields ("five_hour" / "rejected"
 * on a drained bucket). Either shape is sufficient — see insight
 * `58dc6cb6-5ef7-46ab-a158-611f054604cf` for the observed payloads.
 *
 * Structural walk (not a schema) because Anthropic's body shape is
 * undocumented for subscription rate limits and has already varied
 * between top-level and nested `error` / `rate_limit_event` positions.
 * Unknown shapes fall through as false so we never spuriously failover
 * on an unrelated 429.
 */
function bodyIndicatesRateLimitRejection(body: unknown): boolean {
	if (body === null || body === undefined) return false
	if (typeof body === 'string') {
		return (
			body.includes('"type":"rate_limit_error"') ||
			body.includes('"overageStatus":"rejected"') ||
			body.includes('"rateLimitType":"five_hour"')
		)
	}
	if (typeof body !== 'object') return false
	return objectHasRateLimitRejection(body as Record<string, unknown>, 0)
}

function objectHasRateLimitRejection(node: Record<string, unknown>, depth: number): boolean {
	if (depth > 4) return false
	const type = node.type
	if (typeof type === 'string' && type === 'rate_limit_error') return true
	const overageStatus = node.overageStatus ?? node.overage_status
	if (typeof overageStatus === 'string' && overageStatus.toLowerCase() === 'rejected') {
		return true
	}
	const rateLimitType = node.rateLimitType ?? node.rate_limit_type
	if (typeof rateLimitType === 'string' && rateLimitType.toLowerCase() === 'five_hour') {
		return true
	}
	for (const value of Object.values(node)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			if (objectHasRateLimitRejection(value as Record<string, unknown>, depth + 1)) return true
		}
	}
	return false
}

/**
 * Adapter for callers that have a plain record of headers (e.g. from a
 * mocked response or a non-`fetch` HTTP client). Header names are
 * normalised to lower-case so `Headers`-style case-insensitive lookup
 * works without surprises.
 */
export function headersFrom(record: Record<string, string | undefined>): HeaderLookup {
	const normalised: Record<string, string> = {}
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) normalised[key.toLowerCase()] = value
	}
	return {
		get(name: string): string | null {
			const value = normalised[name.toLowerCase()]
			return value === undefined ? null : value
		},
	}
}
