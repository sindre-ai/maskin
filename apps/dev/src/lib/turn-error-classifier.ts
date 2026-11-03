/**
 * Classifies the text a Claude Code CLI turn closes with when its `result`
 * envelope carries `is_error: true`.
 *
 * An interactive session does NOT exit when a turn fails against the model API
 * — the CLI writes `{"type":"result","is_error":true,"result":"API Error: …"}`
 * and goes back to waiting on stdin. That means none of the session-boundary
 * machinery (`classifyCreditExhaustion`, the OAuth failover in
 * `claude-failover.ts`) ever sees these: they only run on a non-zero exit.
 * Without this classifier the raw error envelope is posted into the chat as if
 * it were the agent's reply, and the human has to re-send by hand.
 *
 * Only 'transient' is worth an automatic retry. Everything else needs either a
 * human (credentials, credit) or the failover path, so retrying it just burns
 * the same failure two more times and delays the message that explains it.
 */
export type TurnErrorKind = 'transient' | 'permanent'

/**
 * A 403 whose body is a Cloudflare block page ("Attention Required!
 * | Cloudflare"), i.e. the provider's edge refused the request before it ever
 * reached the model API. The CLI words every 403 as "Failed to authenticate",
 * which is wrong here: the key is fine and the block usually lifts on its own,
 * so it is retried rather than reported as a credential problem. A real bad key
 * is a 401 with a JSON body and never matches.
 */
export function isProviderBlockPage(text: string): boolean {
	return /\b403\b/.test(text) && /Attention Required|Cloudflare/i.test(text)
}

/**
 * The Cloudflare Ray ID, when the block page's text carries one. Support can
 * trace a block to the rule that fired from this id alone. The CLI usually
 * keeps only the page title, so null is common.
 */
export function extractCloudflareRayId(text: string): string | null {
	const match = /Ray ID:?\s*(?:<[^>]*>\s*)*([0-9a-f]{16})\b/i.exec(text)
	return match?.[1] ?? null
}

/**
 * Checked FIRST, so an auth/quota failure can never be read as transient just
 * because its body happens to mention a 5xx. These mirror the banner strings
 * in `credit-classifier.ts` — that classifier owns the session-exit path, this
 * one owns the per-turn path, and they must agree on what is not retryable.
 */
const PERMANENT_MARKERS: readonly string[] = [
	"You've hit your limit",
	"You've hit your session limit",
	"You've hit your weekly limit",
	"You've hit your Opus limit",
	'Credit balance is too low',
	'Not logged in',
	'OAuth token has expired',
	'authentication_error',
	'permission_error',
	'invalid_request_error',
	'billing_error',
	'insufficient credits',
]

/**
 * Server-side faults and throughput blips: the same request stands a good
 * chance of succeeding a few seconds later.
 *
 * `rate_limit_error` / 429 is deliberately here rather than in the permanent
 * list. A plan-level exhaustion surfaces as one of the banner strings above
 * and is caught first; a bare 429 that reaches this point is a throughput
 * burst, which is exactly what backoff is for — the same reading
 * `claude-failure-classifier.ts` takes on a 429 without an `exhausted` header.
 */
const TRANSIENT_MARKERS: readonly string[] = [
	'api_error',
	'Internal server error',
	'overloaded_error',
	'Overloaded',
	'rate_limit_error',
	'Server is temporarily limiting requests',
	'Request rejected (429)',
	'502 Bad Gateway',
	'503 Service Unavailable',
	'504 Gateway Timeout',
	'529',
	'ECONNRESET',
	'ETIMEDOUT',
	'socket hang up',
	'fetch failed',
]

/**
 * Anything unrecognised is 'permanent' on purpose: an unknown failure retried
 * automatically is an invisible cost multiplier, whereas an unknown failure
 * reported to the human is one message they can act on. Widen
 * TRANSIENT_MARKERS when a real recurring case shows up, rather than flipping
 * the default.
 */
export function classifyTurnError(text: string): TurnErrorKind {
	if (isProviderBlockPage(text)) return 'transient'
	if (PERMANENT_MARKERS.some((marker) => text.includes(marker))) return 'permanent'
	if (TRANSIENT_MARKERS.some((marker) => text.includes(marker))) return 'transient'
	return 'permanent'
}
