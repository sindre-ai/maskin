import { describe, expect, it } from 'vitest'
import {
	MeetToolError,
	classifyGoogleFailure,
} from '../../../../lib/integrations/providers/google-meet/errors'

describe('classifyGoogleFailure', () => {
	it('maps 401 to RECONSENT_REQUIRED', () => {
		const err = classifyGoogleFailure(401, { error: { message: 'invalid_credentials' } })
		expect(err).toBeInstanceOf(MeetToolError)
		expect(err.code).toBe('RECONSENT_REQUIRED')
		expect(err.providerStatus).toBe(401)
		expect(err.toEnvelope().error.hint).toMatch(/reconnect/i)
	})

	it('maps 403 mentioning "workspace" to MEET_REQUIRES_WORKSPACE — the free-consumer case', () => {
		const err = classifyGoogleFailure(403, {
			error: {
				message: 'Meet requires Google Workspace to provision spaces',
				status: 'PERMISSION_DENIED',
				details: [{ reason: 'CONSUMER_NOT_ELIGIBLE' }],
			},
		})
		expect(err.code).toBe('MEET_REQUIRES_WORKSPACE')
	})

	it('maps 403 mentioning scope to RECONSENT_REQUIRED, not MEETING_NOT_OWNED_BY_ACTOR', () => {
		const err = classifyGoogleFailure(403, {
			error: {
				message: 'Insufficient scope',
				status: 'PERMISSION_DENIED',
				details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
			},
		})
		expect(err.code).toBe('RECONSENT_REQUIRED')
	})

	it('maps generic 403 to MEETING_NOT_OWNED_BY_ACTOR', () => {
		const err = classifyGoogleFailure(403, {
			error: { message: 'The caller does not have permission' },
		})
		expect(err.code).toBe('MEETING_NOT_OWNED_BY_ACTOR')
	})

	it('maps 404 to NOT_FOUND', () => {
		const err = classifyGoogleFailure(404, { error: { message: 'Calendar not found' } })
		expect(err.code).toBe('NOT_FOUND')
	})

	it('maps 429 to RATE_LIMITED and parses Retry-After header (seconds form)', () => {
		const err = classifyGoogleFailure(429, undefined, { retryAfterHeader: '30' })
		expect(err.code).toBe('RATE_LIMITED')
		expect(err.retryAfterMs).toBe(30_000)
	})

	it('maps 500 to PROVIDER_ERROR', () => {
		const err = classifyGoogleFailure(500, { error: { message: 'internal' } })
		expect(err.code).toBe('PROVIDER_ERROR')
	})

	it('envelope carries provider_status + hint + retry_after_ms when present', () => {
		const err = new MeetToolError('RATE_LIMITED', 'slow down', {
			providerStatus: 429,
			retryAfterMs: 2000,
			hint: 'wait',
		})
		const env = err.toEnvelope().error
		expect(env.code).toBe('RATE_LIMITED')
		expect(env.provider_status).toBe(429)
		expect(env.retry_after_ms).toBe(2000)
		expect(env.hint).toBe('wait')
	})
})
