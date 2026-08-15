import type { SessionResultFailureReason } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { deriveQuotaContext } from '../../services/session-quota-context'

function reason(overrides: Partial<SessionResultFailureReason>): SessionResultFailureReason {
	return {
		provider: 'anthropic',
		reason_code: 'session_limit',
		human_message: 'Claude session limit reached',
		http_status: null,
		reset_at: null,
		verbatim_output: null,
		...overrides,
	}
}

describe('deriveQuotaContext', () => {
	it('returns null route + null error_code when no failure reason is present', () => {
		expect(deriveQuotaContext(null)).toEqual({ route: null, error_code: null })
	})

	it('maps OpenRouter insufficient_credits (402) onto the openrouter route with HTTP_402', () => {
		expect(
			deriveQuotaContext(
				reason({
					provider: 'openrouter',
					reason_code: 'insufficient_credits',
					http_status: 402,
				}),
			),
		).toEqual({ route: 'openrouter', error_code: 'HTTP_402' })
	})

	it('maps Anthropic weekly_limit onto claude_weekly (route split matches poller taxonomy)', () => {
		// The classifier populates http_status: null for CLI-banner-driven
		// weekly limits — deriveQuotaContext must still emit the route so the
		// PostHog cohort join can slice by "which claude window blew up" even
		// when no HTTP code was surfaced.
		expect(
			deriveQuotaContext(
				reason({
					provider: 'anthropic',
					reason_code: 'weekly_limit',
					http_status: null,
				}),
			),
		).toEqual({ route: 'claude_weekly', error_code: null })
	})

	it('maps Anthropic 5h-window CLI reasons onto claude_5h_overage', () => {
		for (const code of [
			'session_limit',
			'opus_limit',
			'server_rate_limit',
			'request_rejected_429',
			'credit_balance_low',
			'not_logged_in',
			'billing_error',
			'max_plan_rate_limit',
			'rate_limit_error',
		] as const) {
			expect(deriveQuotaContext(reason({ provider: 'anthropic', reason_code: code })).route).toBe(
				'claude_5h_overage',
			)
		}
	})

	it('maps Anthropic rate_limit_error (429) onto claude_5h_overage with HTTP_429', () => {
		expect(
			deriveQuotaContext(
				reason({
					provider: 'anthropic',
					reason_code: 'rate_limit_error',
					http_status: 429,
				}),
			),
		).toEqual({ route: 'claude_5h_overage', error_code: 'HTTP_429' })
	})

	it('maps Anthropic billing_error (402) onto claude_5h_overage with HTTP_402', () => {
		expect(
			deriveQuotaContext(
				reason({
					provider: 'anthropic',
					reason_code: 'billing_error',
					http_status: 402,
				}),
			),
		).toEqual({ route: 'claude_5h_overage', error_code: 'HTTP_402' })
	})

	it('collapses non-quota providers (e.g. agent_server_lost) to null route', () => {
		// The reconciler emits agent_server_lost for infrastructure loss — it is
		// not a quota event, so the AC-T3 cohort filter (error_code IN HTTP_402/
		// HTTP_429) will correctly exclude it while the event itself still fires.
		expect(
			deriveQuotaContext({
				provider: 'agent-server',
				reason_code: 'agent_server_lost',
				human_message: 'lost',
				http_status: null,
				reset_at: null,
				verbatim_output: null,
			}),
		).toEqual({ route: null, error_code: null })
	})

	it('ignores http_status values that are not the two quota-shaped codes', () => {
		expect(
			deriveQuotaContext(
				reason({
					provider: 'anthropic',
					reason_code: 'server_rate_limit',
					http_status: 503,
				}),
			),
		).toEqual({ route: 'claude_5h_overage', error_code: null })
	})
})
