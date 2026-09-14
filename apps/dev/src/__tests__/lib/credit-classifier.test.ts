import { describe, expect, it } from 'vitest'
import { classifyCreditExhaustion } from '../../lib/credit-classifier'

describe('classifyCreditExhaustion', () => {
	describe('Claude Code CLI banner strings', () => {
		it('classifies session limit banner', () => {
			const result = classifyCreditExhaustion(
				"Some output\nYou've hit your session limit\nYour limit resets soon",
			)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'session_limit',
				http_status: null,
				verbatim_output: "You've hit your session limit",
			})
		})

		it('classifies weekly limit banner', () => {
			const result = classifyCreditExhaustion("You've hit your weekly limit")
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'weekly_limit',
				verbatim_output: "You've hit your weekly limit",
			})
		})

		it('classifies generic limit banner from rate_limit_event exits', () => {
			const result = classifyCreditExhaustion(
				'{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour"}}\nYou\'ve hit your limit · resets 3:20pm (UTC)',
			)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'session_limit',
				verbatim_output: "You've hit your limit",
			})
		})

		it('classifies Opus limit banner', () => {
			const result = classifyCreditExhaustion("You've hit your Opus limit")
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'opus_limit',
				verbatim_output: "You've hit your Opus limit",
			})
		})

		it('classifies server rate limit banner', () => {
			const result = classifyCreditExhaustion('Server is temporarily limiting requests')
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'server_rate_limit',
				verbatim_output: 'Server is temporarily limiting requests',
			})
		})

		it('classifies request rejected 429 banner', () => {
			const result = classifyCreditExhaustion('Request rejected (429)')
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'request_rejected_429',
				verbatim_output: 'Request rejected (429)',
			})
		})

		it('classifies credit balance low banner', () => {
			const result = classifyCreditExhaustion('Credit balance is too low')
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'credit_balance_low',
				verbatim_output: 'Credit balance is too low',
			})
		})

		it('classifies OAuth-revoked banner from real Anthropic 401 output', () => {
			// Exact result-line the Claude Code CLI wrote when Anthropic
			// returned 401 authentication_error with body
			// `"OAuth access token has been revoked."` on a rotated Max token
			// (observed live 2026-09-10). The runtime failover reason mapping
			// in session-manager.ts::claudeRuntimeFailoverReason routes this
			// through the same maybeRetryClaudeOAuthOnNextSlot path as the
			// spent-subscription banners.
			const result = classifyCreditExhaustion(
				'{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"authentication_error\\",\\"message\\":\\"OAuth access token has been revoked.\\"}}"}',
			)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'oauth_revoked',
				http_status: null,
				verbatim_output: 'OAuth access token has been revoked',
			})
		})

		it('classifies OAuth-revoked banner under the strict exit-0 gate too', () => {
			// A revoked-mid-turn interactive session exits cleanly (is_error:true
			// but subtype:success), so the exit-0 path must still trip on the
			// literal CLI banner — it's high-confidence, not one of the bare
			// substrings the ambiguous gate exists to suppress.
			const result = classifyCreditExhaustion('OAuth access token has been revoked', {
				includeAmbiguousSignals: false,
			})
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'oauth_revoked',
			})
		})

		it('classifies not logged in banner', () => {
			const result = classifyCreditExhaustion(
				'Not logged in · Please run /login\nSession failed with exit code 1',
			)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'not_logged_in',
				http_status: null,
				verbatim_output: 'Not logged in',
			})
		})

		it('banner match sets reset_at to null', () => {
			const result = classifyCreditExhaustion("You've hit your session limit")
			expect(result?.reset_at).toBeNull()
		})
	})

	describe('Anthropic HTTP error type strings', () => {
		it('classifies billing_error as credit exhaustion', () => {
			const tail = JSON.stringify({
				type: 'error',
				error: {
					type: 'error',
					error: { type: 'billing_error', message: 'Your account has run out of credits' },
				},
			})
			const result = classifyCreditExhaustion(tail)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'billing_error',
				http_status: 402,
			})
		})

		it('classifies Max plan 402 with try-again body as max_plan_rate_limit', () => {
			const tail = 'billing_error — usage/rate limit exceeded, try again later'
			const result = classifyCreditExhaustion(tail)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'max_plan_rate_limit',
				http_status: 402,
			})
		})

		it('classifies Max plan 402 with usage/rate limit body', () => {
			const tail = 'billing_error: usage/rate limit'
			const result = classifyCreditExhaustion(tail)
			expect(result).toMatchObject({
				reason_code: 'max_plan_rate_limit',
			})
		})

		it('classifies rate_limit_error as 429', () => {
			const tail = JSON.stringify({
				type: 'error',
				error: {
					type: 'error',
					error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
				},
			})
			const result = classifyCreditExhaustion(tail)
			expect(result).toMatchObject({
				provider: 'anthropic',
				reason_code: 'rate_limit_error',
				http_status: 429,
			})
		})
	})

	describe('OpenRouter', () => {
		it('classifies OpenRouter insufficient credits', () => {
			const tail = 'OpenRouter error 402: insufficient credits'
			const result = classifyCreditExhaustion(tail)
			expect(result).toMatchObject({
				provider: 'openrouter',
				reason_code: 'insufficient_credits',
				http_status: 402,
			})
		})
	})

	describe('null path', () => {
		it('returns null for a clean exit tail', () => {
			expect(classifyCreditExhaustion('Task completed successfully')).toBeNull()
		})

		it('returns null for empty string', () => {
			expect(classifyCreditExhaustion('')).toBeNull()
		})

		it('returns null for generic error output', () => {
			expect(classifyCreditExhaustion('Error: ENOENT: no such file or directory')).toBeNull()
		})

		it('returns null for container OOM kill', () => {
			expect(classifyCreditExhaustion('Killed\nProcess exited with code 137')).toBeNull()
		})
	})

	describe('false-positive risk (known behavior)', () => {
		it('triggers billing_error classification on unrelated tool output containing the substring', () => {
			// An agent session echoing an API error envelope in its stdout will false-positive.
			// This is a known trade-off; see the comment in credit-classifier.ts.
			const tail = 'Tool result: {"error":"billing_error: connection refused"}'
			const result = classifyCreditExhaustion(tail)
			expect(result?.reason_code).toBe('billing_error')
		})

		it('triggers rate_limit_error classification on unrelated tool output containing the substring', () => {
			// Same risk applies to rate_limit_error.
			const tail = 'Caught upstream rate_limit_error from external service'
			const result = classifyCreditExhaustion(tail)
			expect(result?.reason_code).toBe('rate_limit_error')
		})
	})

	describe('banner takes priority over HTTP strings', () => {
		it('returns banner match when both signals present', () => {
			const tail = "You've hit your session limit\nbilling_error"
			const result = classifyCreditExhaustion(tail)
			expect(result?.reason_code).toBe('session_limit')
		})
	})
})

describe('classifyCreditExhaustion — OpenRouter error envelopes', () => {
	// Before these, the only OpenRouter failure we recognised was the literal
	// string "insufficient credits"; a rate-limited session classified as null,
	// so nothing was recorded and nothing could fail over on it.
	it('classifies a 402 envelope as insufficient credits', () => {
		const tail =
			'POST https://openrouter.ai/api/v1/chat/completions\n{"error":{"code":402,"message":"Prompt tokens limit exceeded"}}'

		expect(classifyCreditExhaustion(tail)).toMatchObject({
			provider: 'openrouter',
			reason_code: 'insufficient_credits',
			http_status: 402,
		})
	})

	it('classifies a 429 envelope as a rate limit', () => {
		const tail =
			'POST https://openrouter.ai/api/v1/chat/completions\n{"error":{"code":429,"message":"Rate limit exceeded"}}'

		expect(classifyCreditExhaustion(tail)).toMatchObject({
			provider: 'openrouter',
			reason_code: 'rate_limit_error',
			http_status: 429,
		})
	})

	it('ignores an error envelope from some other service', () => {
		// The tail is a whole session's stdout and routinely carries other
		// APIs' error bodies — the OpenRouter host is what makes it ours.
		const tail = '{"error":{"code":429,"message":"Rate limit exceeded"}} from api.example.com'

		expect(classifyCreditExhaustion(tail)).toBeNull()
	})

	it('leaves an unmapped OpenRouter status unclassified', () => {
		const tail = 'https://openrouter.ai/api\n{"error":{"code":418,"message":"teapot"}}'

		expect(classifyCreditExhaustion(tail)).toBeNull()
	})

	it('does not classify an OpenRouter envelope when ambiguous signals are off', () => {
		const tail = 'https://openrouter.ai/api\n{"error":{"code":402,"message":"no credits"}}'

		expect(classifyCreditExhaustion(tail, { includeAmbiguousSignals: false })).toBeNull()
	})
})

/**
 * The structured envelope the CLI emits just before its banner. Everything the
 * banner cannot express lives here, and none of it used to be read: a seven-day
 * exhaustion and a 5-hour one were both filed as `session_limit` with
 * `reset_at: null`, and `overageDisabledReason` — the field that explains why a
 * workspace with credit still cannot spend it — was discarded entirely.
 *
 * Payloads below are the verbatim shape from real failed Vaerksted sessions on
 * 2026-09-14, not invented ones. The spelling is the whole point: the API says
 * `seven_day`, and the code that tried to detect a weekly limit matched
 * `"rateLimitType":"weekly"`, so it had never once fired.
 */
describe('classifyCreditExhaustion — structured rate_limit_event envelope', () => {
	const sevenDay =
		'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789416000,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}\n' +
		"You've hit your limit · resets 8pm (UTC)\n"

	it('classifies a seven_day limit as weekly, not as a session limit', () => {
		const result = classifyCreditExhaustion(sevenDay)
		// The banner alone says "You've hit your limit", which the CLI_BANNERS
		// list maps to `session_limit` — a materially different thing from a
		// weekly cap, and the reason a 12-hour outage looked like a 5-hour one.
		expect(result?.reason_code).toBe('weekly_limit')
	})

	it('carries the provider reset time instead of a null reset_at', () => {
		const result = classifyCreditExhaustion(sevenDay)
		expect(result?.reset_at).toBe(new Date(1789416000 * 1000).toISOString())
	})

	it('says overage is org-disabled, since that is the only actionable part', () => {
		const result = classifyCreditExhaustion(sevenDay)
		expect(result?.human_message).toMatch(/overage is disabled/i)
	})

	it('classifies a five_hour limit as a session limit', () => {
		const result = classifyCreditExhaustion(
			'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788532200,"rateLimitType":"five_hour","overageStatus":"allowed","isUsingOverage":false}}\n' +
				"You've hit your limit · resets 2:30pm (UTC)\n",
		)
		expect(result?.reason_code).toBe('session_limit')
		expect(result?.human_message).not.toMatch(/overage is disabled/i)
	})

	it('ignores an allowed event — only a rejection is a failure', () => {
		const result = classifyCreditExhaustion(
			'{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}\n',
		)
		expect(result).toBeNull()
	})

	it('falls through to the banner when the limit type is unrecognised', () => {
		// An unmapped type must not invent a classification — the banner is still
		// a real signal and stays the fallback.
		const result = classifyCreditExhaustion(
			'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"some_future_window"}}\n' +
				"You've hit your limit\n",
		)
		expect(result?.reason_code).toBe('session_limit')
		expect(result?.reset_at).toBeNull()
	})

	it('takes the last rejection when a session reported several', () => {
		const result = classifyCreditExhaustion(
			'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1788532200}}\n' +
				'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day","resetsAt":1789416000}}\n',
		)
		expect(result?.reason_code).toBe('weekly_limit')
	})

	it('ignores a malformed envelope rather than throwing', () => {
		const result = classifyCreditExhaustion('{"type":"rate_limit_event", this is not json\n')
		expect(result).toBeNull()
	})
})
