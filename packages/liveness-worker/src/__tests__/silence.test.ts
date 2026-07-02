import { describe, expect, it } from 'vitest'
import type { HeartbeatResult } from '../heartbeat'
import { evaluateSilence } from '../silence'

function ok(body: {
	latest_completed_at: string | null
	minutes_since: number | null
}): HeartbeatResult {
	return { kind: 'ok', body }
}

describe('evaluateSilence', () => {
	it('is not silent when minutes_since is below the threshold', () => {
		const v = evaluateSilence(
			ok({ latest_completed_at: '2026-07-02T00:00:00.000Z', minutes_since: 4 }),
			8,
		)
		expect(v.silent).toBe(false)
	})

	it('is not silent at exactly the threshold (rule uses strict >)', () => {
		const v = evaluateSilence(
			ok({ latest_completed_at: '2026-07-02T00:00:00.000Z', minutes_since: 8 }),
			8,
		)
		expect(v.silent).toBe(false)
	})

	it('is silent one minute past the threshold', () => {
		const v = evaluateSilence(
			ok({ latest_completed_at: '2026-07-02T00:00:00.000Z', minutes_since: 9 }),
			8,
		)
		expect(v.silent).toBe(true)
		if (v.silent) {
			expect(v.reason).toBe('threshold_exceeded')
			expect(v.minutes_since).toBe(9)
			expect(v.latest_completed_at).toBe('2026-07-02T00:00:00.000Z')
		}
	})

	it('is silent when latest_completed_at is null (empty sessions table)', () => {
		const v = evaluateSilence(ok({ latest_completed_at: null, minutes_since: null }), 8)
		expect(v.silent).toBe(true)
		if (v.silent) expect(v.reason).toBe('null_latest')
	})

	it('is silent on non-2xx (worker treats 5xx as silence)', () => {
		const v = evaluateSilence({ kind: 'non_2xx', status: 503 }, 8)
		expect(v.silent).toBe(true)
		if (v.silent) {
			expect(v.reason).toBe('non_2xx')
			expect(v.status).toBe(503)
		}
	})

	it('is silent on a 4xx (misconfigured auth from the worker side still means we cannot see the fleet)', () => {
		const v = evaluateSilence({ kind: 'non_2xx', status: 401 }, 8)
		expect(v.silent).toBe(true)
		if (v.silent) expect(v.reason).toBe('non_2xx')
	})

	it('is silent on network error', () => {
		const v = evaluateSilence({ kind: 'network_error', message: 'ECONNREFUSED' }, 8)
		expect(v.silent).toBe(true)
		if (v.silent) {
			expect(v.reason).toBe('network_error')
			expect(v.error_message).toBe('ECONNREFUSED')
		}
	})

	it('is silent on malformed body', () => {
		const v = evaluateSilence({ kind: 'malformed', status: 200 }, 8)
		expect(v.silent).toBe(true)
		if (v.silent) expect(v.reason).toBe('malformed')
	})
})
