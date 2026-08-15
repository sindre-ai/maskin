import { describe, expect, it } from 'vitest'
import {
	type ClassifierInput,
	classifyClaudeFailure,
	headersFrom,
} from '../../lib/claude-failure-classifier'

const httpResponse = (
	status: number,
	headers: Record<string, string | undefined> = {},
): ClassifierInput => ({
	kind: 'http',
	status,
	headers: headersFrom(headers),
})

describe('classifyClaudeFailure', () => {
	describe('AC-T3 fixtures — the five required classes', () => {
		it('401 → failover with auth_failed', () => {
			const decision = classifyClaudeFailure(httpResponse(401))
			expect(decision).toEqual({ action: 'failover', reason: 'auth_failed' })
		})

		it('429 without an exhausted marker → retry_primary with throughput_burst', () => {
			const decision = classifyClaudeFailure(httpResponse(429, { 'retry-after': '30' }))
			expect(decision).toEqual({ action: 'retry_primary', reason: 'throughput_burst' })
		})

		it('429 with anthropic-ratelimit-unified-status: exhausted → failover with quota_exhausted', () => {
			const decision = classifyClaudeFailure(
				httpResponse(429, { 'anthropic-ratelimit-unified-status': 'exhausted' }),
			)
			expect(decision).toEqual({ action: 'failover', reason: 'quota_exhausted' })
		})

		it('5xx → retry_primary with server_error', () => {
			const decision = classifyClaudeFailure(httpResponse(503))
			expect(decision).toEqual({ action: 'retry_primary', reason: 'server_error' })
		})

		it('transport timeout → retry_primary with network_timeout', () => {
			const decision = classifyClaudeFailure({ kind: 'transport', error: 'timeout' })
			expect(decision).toEqual({ action: 'retry_primary', reason: 'network_timeout' })
		})
	})

	describe('429 header precedence', () => {
		it('exhausted header wins even when retry-after suggests a transient burst', () => {
			const decision = classifyClaudeFailure(
				httpResponse(429, {
					'anthropic-ratelimit-unified-status': 'exhausted',
					'retry-after': '10',
				}),
			)
			expect(decision).toEqual({ action: 'failover', reason: 'quota_exhausted' })
		})

		it('429 with no usable headers stays on the primary', () => {
			const decision = classifyClaudeFailure(httpResponse(429))
			expect(decision).toEqual({ action: 'retry_primary', reason: 'throughput_burst' })
		})

		it('429 with unrelated unified-status header value falls through to retry', () => {
			const decision = classifyClaudeFailure(
				httpResponse(429, { 'anthropic-ratelimit-unified-status': 'ok' }),
			)
			expect(decision.action).toBe('retry_primary')
		})

		it('exhausted header is matched case-insensitively', () => {
			const decision = classifyClaudeFailure(
				httpResponse(429, { 'anthropic-ratelimit-unified-status': 'EXHAUSTED' }),
			)
			expect(decision).toEqual({ action: 'failover', reason: 'quota_exhausted' })
		})
	})

	describe('5xx range', () => {
		it('500 retries the primary', () => {
			expect(classifyClaudeFailure(httpResponse(500)).reason).toBe('server_error')
		})

		it('599 retries the primary', () => {
			expect(classifyClaudeFailure(httpResponse(599)).reason).toBe('server_error')
		})
	})

	describe('transport failures', () => {
		it('network error retries the primary', () => {
			const decision = classifyClaudeFailure({ kind: 'transport', error: 'network' })
			expect(decision).toEqual({ action: 'retry_primary', reason: 'network_timeout' })
		})
	})

	describe('headers adapter', () => {
		it('looks up headers case-insensitively', () => {
			const headers = headersFrom({ 'Retry-After': '12' })
			expect(headers.get('retry-after')).toBe('12')
			expect(headers.get('RETRY-AFTER')).toBe('12')
		})

		it('returns null for missing headers', () => {
			const headers = headersFrom({})
			expect(headers.get('retry-after')).toBeNull()
		})

		it('treats undefined values as absent', () => {
			const headers = headersFrom({ 'retry-after': undefined })
			expect(headers.get('retry-after')).toBeNull()
		})

		it('works with a real Headers instance', () => {
			const real = new Headers({ 'retry-after': '15' })
			const decision = classifyClaudeFailure({ kind: 'http', status: 429, headers: real })
			expect(decision.reason).toBe('throughput_burst')
		})
	})
})
