import { describe, expect, it } from 'vitest'
import {
	MEET_ERROR_CODES,
	MeetError,
	classifyGoogleError,
	isMeetError,
} from '../../../../lib/integrations/providers/google-meet/errors'

describe('MeetError envelope', () => {
	it('exposes the closed set of codes shipped by the write-path task', () => {
		expect(new Set(MEET_ERROR_CODES)).toEqual(
			new Set([
				'RECONSENT_REQUIRED',
				'PROVIDER_ERROR',
				'NOT_FOUND',
				'RATE_LIMITED',
				'MEET_REQUIRES_WORKSPACE',
				'MEETING_NOT_OWNED_BY_ACTOR',
			]),
		)
	})

	it('serialises the wire shape from the spec — code, message, provider_status, optional retry_after_ms + hint', () => {
		const err = new MeetError({
			code: 'RATE_LIMITED',
			message: 'try later',
			provider_status: 429,
			retry_after_ms: 1500,
			hint: 'wait a beat',
		})
		expect(err.toEnvelope()).toEqual({
			code: 'RATE_LIMITED',
			message: 'try later',
			provider_status: 429,
			retry_after_ms: 1500,
			hint: 'wait a beat',
		})
	})

	it('omits optional fields when unset — no undefined leaks into JSON', () => {
		const err = new MeetError({
			code: 'NOT_FOUND',
			message: 'no calendar',
			provider_status: 404,
		})
		const env = err.toEnvelope()
		expect(env).toEqual({ code: 'NOT_FOUND', message: 'no calendar', provider_status: 404 })
		expect(Object.keys(env)).not.toContain('retry_after_ms')
		expect(Object.keys(env)).not.toContain('hint')
	})

	it('isMeetError narrows unknown thrown values', () => {
		expect(isMeetError(new MeetError({ code: 'PROVIDER_ERROR', message: 'x', provider_status: 0 }))).toBe(true)
		expect(isMeetError(new Error('plain'))).toBe(false)
		expect(isMeetError('string')).toBe(false)
		expect(isMeetError(null)).toBe(false)
	})
})

describe('classifyGoogleError — status → code mapping', () => {
	it('maps 401 → RECONSENT_REQUIRED with the reconnect hint', () => {
		const err = classifyGoogleError({
			status: 401,
			bodyText: '{"error":{"code":401,"message":"Invalid Credentials"}}',
			body: { error: { code: 401, message: 'Invalid Credentials' } },
		})
		expect(err.code).toBe('RECONSENT_REQUIRED')
		expect(err.providerStatus).toBe(401)
		expect(err.hint).toMatch(/reconnect/i)
	})

	it('maps 403 with missing meetings.space.created scope → RECONSENT_REQUIRED (not PROVIDER_ERROR)', () => {
		const err = classifyGoogleError({
			status: 403,
			bodyText: JSON.stringify({
				error: {
					code: 403,
					message:
						'Request had insufficient authentication scopes.',
					details: [
						{
							scope: 'https://www.googleapis.com/auth/meetings.space.created',
						},
					],
				},
			}),
			body: {
				error: { message: 'Request had insufficient authentication scopes.' },
			},
		})
		expect(err.code).toBe('RECONSENT_REQUIRED')
		expect(err.message).toMatch(/meetings\.space\.created/)
	})

	it('maps 403 with a "requires Google Workspace" body → MEET_REQUIRES_WORKSPACE', () => {
		const err = classifyGoogleError({
			status: 403,
			bodyText: JSON.stringify({
				error: {
					message:
						'This request requires a Google Workspace account. Free consumer accounts cannot create Meet spaces via the API.',
				},
			}),
			body: {
				error: {
					message:
						'This request requires a Google Workspace account. Free consumer accounts cannot create Meet spaces via the API.',
				},
			},
		})
		expect(err.code).toBe('MEET_REQUIRES_WORKSPACE')
		expect(err.hint).toMatch(/consumer/i)
	})

	it('maps 403 without a special marker → PROVIDER_ERROR carrying the provider message', () => {
		const err = classifyGoogleError({
			status: 403,
			bodyText: JSON.stringify({ error: { message: 'Forbidden for unrelated reasons.' } }),
			body: { error: { message: 'Forbidden for unrelated reasons.' } },
		})
		expect(err.code).toBe('PROVIDER_ERROR')
		expect(err.message).toBe('Forbidden for unrelated reasons.')
	})

	it('maps 404 → NOT_FOUND', () => {
		const err = classifyGoogleError({
			status: 404,
			bodyText: JSON.stringify({ error: { message: 'Calendar not found' } }),
			body: { error: { message: 'Calendar not found' } },
		})
		expect(err.code).toBe('NOT_FOUND')
		expect(err.message).toMatch(/Calendar not found/)
	})

	it('maps 429 → RATE_LIMITED and parses Retry-After seconds', () => {
		const err = classifyGoogleError({
			status: 429,
			bodyText: '',
			retryAfterHeader: '3',
		})
		expect(err.code).toBe('RATE_LIMITED')
		expect(err.retryAfterMs).toBe(3000)
	})

	it('parses Retry-After HTTP-date form', () => {
		const future = new Date(Date.now() + 5_000).toUTCString()
		const err = classifyGoogleError({
			status: 429,
			bodyText: '',
			retryAfterHeader: future,
		})
		expect(err.code).toBe('RATE_LIMITED')
		expect(err.retryAfterMs).toBeGreaterThan(3_000)
		expect(err.retryAfterMs).toBeLessThanOrEqual(5_000)
	})

	it('maps 5xx → PROVIDER_ERROR, message defaults to a "Google returned <status>" hint when body is empty', () => {
		const err = classifyGoogleError({ status: 503, bodyText: '' })
		expect(err.code).toBe('PROVIDER_ERROR')
		expect(err.providerStatus).toBe(503)
		expect(err.message).toMatch(/503/)
	})

	it('maps 5xx → PROVIDER_ERROR carrying the raw body text when no JSON is available', () => {
		const err = classifyGoogleError({ status: 503, bodyText: 'upstream barfed' })
		expect(err.code).toBe('PROVIDER_ERROR')
		expect(err.providerStatus).toBe(503)
		expect(err.message).toBe('upstream barfed')
	})

	it('maps unclassified 4xx (e.g. 400) → PROVIDER_ERROR carrying the provider message', () => {
		const err = classifyGoogleError({
			status: 400,
			bodyText: JSON.stringify({ error: { message: 'Bad request: startTime after endTime' } }),
			body: { error: { message: 'Bad request: startTime after endTime' } },
		})
		expect(err.code).toBe('PROVIDER_ERROR')
		expect(err.message).toBe('Bad request: startTime after endTime')
	})
})
