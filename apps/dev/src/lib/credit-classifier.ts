import type { SessionResultFailureReason } from '@maskin/shared'

const CLI_BANNERS: ReadonlyArray<{
	match: string
	reasonCode: string
	humanMessage: string
}> = [
	{
		match: "You've hit your session limit",
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
]

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
 * Every `reasonCode` value emitted here must exist in `failureReasonCodeSchema`
 * in packages/shared/src/schemas/sessions.ts — add new codes there first.
 */
export function classifyCreditExhaustion(tail: string): SessionResultFailureReason | null {
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

	return null
}
