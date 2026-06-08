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

		it('banner match sets reset_at to null', () => {
			const result = classifyCreditExhaustion("You've hit your session limit")
			expect(result?.reset_at).toBeNull()
		})
	})

	describe('Anthropic HTTP error type strings', () => {
		it('classifies billing_error as credit exhaustion', () => {
			const tail = JSON.stringify({
				type: 'error',
				error: { type: 'error', error: { type: 'billing_error', message: 'Your account has run out of credits' } },
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
				error: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
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
			expect(
				classifyCreditExhaustion('Error: ENOENT: no such file or directory'),
			).toBeNull()
		})

		it('returns null for container OOM kill', () => {
			expect(classifyCreditExhaustion('Killed\nProcess exited with code 137')).toBeNull()
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
