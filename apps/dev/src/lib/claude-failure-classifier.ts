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
 * Threshold below which a 429 with `retry-after` is treated as a transient
 * RPM/TPM burst (retry the primary) rather than a quota-exhausted failover
 * signal. From AC-U2: "NOT a transient RPM/TPM throughput limit that carries
 * a retry-after < 60s".
 */
const THROUGHPUT_BURST_RETRY_AFTER_SECONDS = 60

/**
 * Classify a Claude API call failure.
 *
 * Decision order on a 429: an `anthropic-ratelimit-unified-status: exhausted`
 * header always wins — that's the quota-exhausted signal we must failover on.
 * Only if the header is absent do we fall back to the `retry-after` heuristic.
 */
export function classifyClaudeFailure(input: ClassifierInput): ClassifierDecision {
	if (input.kind === 'transport') {
		return { action: 'retry_primary', reason: 'network_timeout' }
	}

	const { status, headers } = input

	if (status === 401) {
		return { action: 'failover', reason: 'auth_failed' }
	}

	if (status === 429) {
		const unified = headers.get('anthropic-ratelimit-unified-status')
		if (unified?.trim().toLowerCase() === 'exhausted') {
			return { action: 'failover', reason: 'quota_exhausted' }
		}
		const retryAfterSeconds = parseRetryAfter(headers.get('retry-after'))
		if (retryAfterSeconds !== null && retryAfterSeconds < THROUGHPUT_BURST_RETRY_AFTER_SECONDS) {
			return { action: 'retry_primary', reason: 'throughput_burst' }
		}
		// A 429 with no usable signal — treat as throughput-burst rather than
		// failing over silently. Failover requires an explicit exhausted marker.
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
 * Parse a `retry-after` header. The HTTP spec allows either an integer
 * seconds value or an HTTP-date; Anthropic's 429s carry the seconds form,
 * but accept the date form too — anything in the past resolves to 0s.
 * Returns null when the header is missing or unparseable.
 */
function parseRetryAfter(raw: string | null): number | null {
	if (raw === null) return null
	const trimmed = raw.trim()
	if (trimmed === '') return null

	const seconds = Number(trimmed)
	if (Number.isFinite(seconds) && seconds >= 0) return seconds

	const dateMs = Date.parse(trimmed)
	if (Number.isNaN(dateMs)) return null
	return Math.max(0, Math.round((dateMs - Date.now()) / 1000))
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
