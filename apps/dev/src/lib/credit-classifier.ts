import type { FailureReasonCode, SessionResultFailureReason } from '@maskin/shared'

const CLI_BANNERS: ReadonlyArray<{
	match: string
	reasonCode: FailureReasonCode
	humanMessage: string
}> = [
	{
		match: "You've hit your session limit",
		reasonCode: 'session_limit',
		humanMessage: 'Claude session limit reached',
	},
	{
		match: "You've hit your limit",
		reasonCode: 'session_limit',
		humanMessage: 'Claude session limit reached',
	},
	{
		match: "You've hit your weekly limit",
		reasonCode: 'weekly_limit',
		humanMessage: 'Claude weekly limit reached',
	},
	{
		match: "You've hit your Opus limit",
		reasonCode: 'opus_limit',
		humanMessage: 'Claude Opus limit reached',
	},
	{
		match: 'Server is temporarily limiting requests',
		reasonCode: 'server_rate_limit',
		humanMessage: 'Claude server is temporarily limiting requests',
	},
	{
		match: 'Request rejected (429)',
		reasonCode: 'request_rejected_429',
		humanMessage: 'Claude request rejected — rate limit',
	},
	{
		match: 'Credit balance is too low',
		reasonCode: 'credit_balance_low',
		humanMessage: 'Claude credit balance is too low',
	},
	{
		match: 'Not logged in',
		reasonCode: 'not_logged_in',
		humanMessage: 'Claude credentials not connected — please import your Claude subscription',
	},
	{
		// The Claude Code CLI prints this line verbatim when Anthropic returns
		// 401 with `error.type = 'authentication_error'` and the message body
		// `"OAuth access token has been revoked."`. Observed live 2026-09-10
		// on a rotated (invalidated) Anthropic Max token. Distinct from the
		// six banners above, which all mean "spent for now" — this means the
		// credential itself is bad. Routing it into the same runtime failover
		// path so the retry lands on the next connected subscription; on that
		// slot the session-start refresh recovers an expired-but-not-revoked
		// token in place, and if the whole slot is dead it walks the chain.
		match: 'OAuth access token has been revoked',
		reasonCode: 'oauth_revoked',
		humanMessage:
			'Claude OAuth token was revoked — moving this workspace to the next connected subscription',
	},
]

/**
 * The structured envelope the Claude Code CLI emits on stdout immediately
 * before the human-readable banner, e.g.
 *
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
 *    "resetsAt":1789416000,"rateLimitType":"seven_day",
 *    "overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
 *    "isUsingOverage":false}}
 *
 * Everything the banner cannot tell us is in here: WHICH limit was hit, WHEN
 * it resets, and whether overage could have covered it. Until this was parsed
 * the classifier matched only the banner, so every limit — a 5-hour one that
 * clears over lunch and a seven-day one that does not clear until tomorrow
 * night — was recorded identically as `session_limit` with `reset_at: null`,
 * and `overageDisabledReason` (the single most actionable field, since it
 * means the subscription was FORBIDDEN from spending available credit) was
 * dropped on the floor.
 */
interface RateLimitInfo {
	status?: string
	resetsAt?: number
	rateLimitType?: string
	overageStatus?: string
	overageDisabledReason?: string
	isUsingOverage?: boolean
}

/**
 * Claude's `rateLimitType` values, mapped to our reason codes.
 *
 * NOTE the spelling: the API emits `seven_day`, NOT `weekly`. Code that
 * matched `"rateLimitType":"weekly"` never fired once in production — it was
 * written from the name of the limit rather than from an observed payload,
 * the same way the retired Slack `search:read` scope was. Both spellings are
 * accepted here so neither a rename nor a rollback silently stops matching.
 */
const RATE_LIMIT_TYPE_REASONS: Record<string, { code: FailureReasonCode; message: string }> = {
	seven_day: { code: 'weekly_limit', message: 'Claude weekly limit reached' },
	weekly: { code: 'weekly_limit', message: 'Claude weekly limit reached' },
	five_hour: { code: 'session_limit', message: 'Claude 5-hour limit reached' },
	opus: { code: 'opus_limit', message: 'Claude Opus limit reached' },
}

/**
 * The last rejected `rate_limit_event` in a stdout tail, or null.
 *
 * Requires a full structural match — parseable JSON, `type` exactly
 * `rate_limit_event`, and `rate_limit_info.status` exactly `rejected` — rather
 * than a bare substring, because an agent session can legitimately echo this
 * shape in tool output while inspecting its own failures. An `allowed` event is
 * informational and deliberately ignored.
 */
export function parseRateLimitEvent(tail: string): RateLimitInfo | null {
	// Last one wins: a long session can report several, and only the final
	// rejection describes the state it actually died in.
	for (const line of tail.split('\n').reverse()) {
		if (!line.includes('"rate_limit_event"')) continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line.trim())
		} catch {
			continue
		}
		if (typeof parsed !== 'object' || parsed === null) continue
		const envelope = parsed as { type?: unknown; rate_limit_info?: unknown }
		if (envelope.type !== 'rate_limit_event') continue
		const info = envelope.rate_limit_info
		if (typeof info !== 'object' || info === null) continue
		const rateLimit = info as RateLimitInfo
		if (rateLimit.status !== 'rejected') continue
		return rateLimit
	}
	return null
}

/** `resetsAt` is epoch SECONDS; `reset_at` on a failure reason is an ISO string. */
function resetAtIso(resetsAt: unknown): string | null {
	if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null
	const ms = resetsAt * 1000
	const date = new Date(ms)
	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Turn a rejected rate-limit envelope into a failure reason. Returns null when
 * the envelope names a limit type we have no mapping for, so the caller falls
 * through to banner matching rather than inventing a classification.
 */
function failureFromRateLimitEvent(info: RateLimitInfo): SessionResultFailureReason | null {
	const mapped = info.rateLimitType ? RATE_LIMIT_TYPE_REASONS[info.rateLimitType] : undefined
	if (!mapped) return null

	const resetAt = resetAtIso(info.resetsAt)
	// Say the one thing a human can act on. A subscription that is merely spent
	// recovers by itself; one whose org has overage switched off will keep
	// refusing every session until somebody changes that setting, however much
	// credit the account holds — which is exactly the state that reads from the
	// outside as "we have credits and it still fails".
	const overageNote =
		info.overageDisabledReason === 'org_level_disabled'
			? ' — overage is disabled for this Anthropic organisation, so the subscription cannot spend past its limit'
			: ''
	const resetNote = resetAt ? ` (resets ${resetAt})` : ''

	return {
		provider: 'anthropic',
		reason_code: mapped.code,
		human_message: `${mapped.message}${resetNote}${overageNote}`,
		http_status: null,
		reset_at: resetAt,
		verbatim_output: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }),
	}
}

/**
 * Inspects the stdout tail from a failed session and returns a typed failure
 * reason if a credit/quota signal is found, or null if the exit is
 * unclassifiable.
 *
 * Classifier order:
 * 1. Claude Code CLI banner strings — six literal matches
 * 2. Anthropic HTTP error type strings — billing_error (402) / rate_limit_error (429)
 *    with Max plan 402 distinguished by body text
 * 3. OpenRouter 402 — 'insufficient credits' substring
 *
 * `includeAmbiguousSignals` (default true) gates steps 2 and 3, which match
 * bare substrings anywhere in the tail and can false-positive on unrelated
 * tool output (see comment below). Callers classifying an exitCode === 0
 * (otherwise-successful) session should pass `false` so only the
 * high-confidence, literal Claude CLI banner strings in step 1 can flip a
 * successful exit to 'failed'.
 *
 * Every `reasonCode` value emitted here must exist in `failureReasonCodeSchema`
 * in packages/shared/src/schemas/sessions.ts — add new codes there first.
 */
export function classifyCreditExhaustion(
	tail: string,
	options: { includeAmbiguousSignals?: boolean } = {},
): SessionResultFailureReason | null {
	const { includeAmbiguousSignals = true } = options

	// Step 0: the structured envelope, ahead of the banners it precedes. It is
	// strictly more informative than the banner for the same event (limit type,
	// reset time, overage state) and is matched structurally, so it is safe even
	// on the high-confidence-only path.
	const rateLimit = parseRateLimitEvent(tail)
	if (rateLimit) {
		const fromEnvelope = failureFromRateLimitEvent(rateLimit)
		if (fromEnvelope) return fromEnvelope
	}

	for (const banner of CLI_BANNERS) {
		if (tail.includes(banner.match)) {
			return {
				provider: 'anthropic',
				reason_code: banner.reasonCode,
				human_message: banner.humanMessage,
				http_status: null,
				reset_at: null,
				verbatim_output: banner.match,
			}
		}
	}

	if (!includeAmbiguousSignals) return null

	// False-positive risk: `billing_error` and `rate_limit_error` are matched as bare
	// substrings anywhere in stdoutTail, which spans the full stdout of the agent session.
	// A Maskin agent session can echo these strings in tool output (e.g. when inspecting
	// an API error envelope, or when code under test prints these strings), triggering a
	// false credit-exhaustion classification.
	//
	// Narrowing to a JSON envelope match (e.g. `"type":"billing_error"`) would reduce
	// false positives but breaks the Max plan 402 path, which surfaces
	// "billing_error — usage/rate limit exceeded" as plain CLI text, not JSON.
	// Accepted trade-off: the classifier is best-effort at session boundary; false-positive
	// rate is low in practice since these are uncommon substrings in typical tool output.
	// This trade-off is only accepted for sessions that already exited non-zero — see
	// `includeAmbiguousSignals` above.
	if (tail.includes('billing_error')) {
		// Max plan returns 402 for temporary rate limits; distinguish by body text
		const isMaxRateLimit = tail.includes('try again') || tail.includes('usage/rate limit')
		return {
			provider: 'anthropic',
			reason_code: isMaxRateLimit ? 'max_plan_rate_limit' : 'billing_error',
			human_message: isMaxRateLimit
				? 'Claude Max plan rate limit reached — try again later'
				: 'Anthropic billing error — credit balance may be exhausted',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		}
	}

	if (tail.includes('rate_limit_error')) {
		return {
			provider: 'anthropic',
			reason_code: 'rate_limit_error',
			human_message: 'Anthropic rate limit reached',
			http_status: 429,
			reset_at: null,
			verbatim_output: null,
		}
	}

	// False-positive risk: `insufficient credits` is matched as a bare substring and can
	// appear in non-OpenRouter tool output (e.g. a DB error or upstream API response).
	// Accepted trade-off: uncommon enough in practice that false-positive rate is low.
	if (tail.includes('insufficient credits')) {
		return {
			provider: 'openrouter',
			reason_code: 'insufficient_credits',
			human_message: 'OpenRouter: insufficient credits',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		}
	}

	return classifyOpenRouterEnvelope(tail)
}

/**
 * Parse an OpenRouter JSON envelope `{"error":{"code":<http status>,…}}` from
 * the stdout tail. Host-gated because a bare `"error":{"code":429}` is a shape
 * plenty of other APIs share, and the tail is the whole session's stdout.
 */
function classifyOpenRouterEnvelope(tail: string): SessionResultFailureReason | null {
	if (!tail.includes('openrouter.ai')) return null

	const match = /"error"\s*:\s*\{[^}]*"code"\s*:\s*(\d{3})/.exec(tail)
	if (!match) return null
	const status = Number(match[1])

	const base = { provider: 'openrouter', reset_at: null, verbatim_output: null } as const
	if (status === 402) {
		return {
			...base,
			reason_code: 'insufficient_credits',
			human_message: 'OpenRouter: insufficient credits',
			http_status: 402,
		}
	}
	if (status === 429) {
		return {
			...base,
			reason_code: 'rate_limit_error',
			human_message: 'OpenRouter rate limit reached',
			http_status: 429,
		}
	}
	return null
}
