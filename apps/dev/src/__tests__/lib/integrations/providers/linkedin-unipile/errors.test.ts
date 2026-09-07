import { describe, expect, it } from 'vitest'
import {
	LINKEDIN_ERROR_CODES,
	LinkedInIntegrationError,
	RETRY_POLICY_BY_CODE,
	UNIPILE_CONNECTION_REQUEST_MARKERS,
	UNIPILE_RESTRICTED_MARKERS,
	classifyUnipileResponse,
	computeBackoffMs,
	isAccountStatusRevoked,
	isLinkedInIntegrationError,
} from '../../../../../lib/integrations/providers/linkedin-unipile/errors'

/**
 * Pure classifier tests. Six-class taxonomy from spec §4 plus the two
 * connect-request codes from Task 7a — every branch has one test that pins
 * the mapping so a future re-shuffle can't silently demote a terminal error
 * to a retryable one.
 */
describe('classifyUnipileResponse', () => {
	it('maps 401 to CREDENTIAL_REVOKED', () => {
		expect(classifyUnipileResponse(401, {})).toBe('CREDENTIAL_REVOKED')
	})

	it('maps 404 to CREDENTIAL_NOT_CONNECTED', () => {
		expect(classifyUnipileResponse(404, {})).toBe('CREDENTIAL_NOT_CONNECTED')
	})

	it('maps 429 to RATE_LIMITED_UNIPILE', () => {
		expect(classifyUnipileResponse(429, {})).toBe('RATE_LIMITED_UNIPILE')
	})

	it('maps 5xx to UNIPILE_UNAVAILABLE', () => {
		expect(classifyUnipileResponse(500, {})).toBe('UNIPILE_UNAVAILABLE')
		expect(classifyUnipileResponse(502, {})).toBe('UNIPILE_UNAVAILABLE')
		expect(classifyUnipileResponse(503, {})).toBe('UNIPILE_UNAVAILABLE')
	})

	it('maps other 4xx to INVALID_INPUT', () => {
		expect(classifyUnipileResponse(400, {})).toBe('INVALID_INPUT')
		expect(classifyUnipileResponse(422, {})).toBe('INVALID_INPUT')
	})

	it('detects LINKEDIN_ACCOUNT_RESTRICTED via disconnected_account_reason marker on a non-2xx body', () => {
		expect(classifyUnipileResponse(400, { disconnected_account_reason: 'RESTRICTED' })).toBe(
			'LINKEDIN_ACCOUNT_RESTRICTED',
		)
	})

	it('detects LINKEDIN_ACCOUNT_RESTRICTED via error_code marker', () => {
		expect(classifyUnipileResponse(422, { error_code: 'account_restricted' })).toBe(
			'LINKEDIN_ACCOUNT_RESTRICTED',
		)
	})

	it('detects LINKEDIN_ACCOUNT_RESTRICTED via account_status marker even on a 200', () => {
		// A restricted account can surface on an otherwise-OK response body
		// (webhook envelope), so the restriction check must run before the
		// happy-path shortcut.
		expect(classifyUnipileResponse(200, { account_status: 'RESTRICTED' })).toBe(
			'LINKEDIN_ACCOUNT_RESTRICTED',
		)
	})

	it('detects LINKEDIN_INVITE_QUOTA_EXCEEDED via error_code on a 400', () => {
		// Marker runs BEFORE the generic 4xx → INVALID_INPUT fallback so the
		// classifier picks the specific taxonomy code — collapsing this into
		// INVALID_INPUT would tell the agent "your body was bad" rather than
		// "stop sending invites from this account this week".
		expect(classifyUnipileResponse(400, { error_code: 'invite_quota_exceeded' })).toBe(
			'LINKEDIN_INVITE_QUOTA_EXCEEDED',
		)
	})

	it('detects LINKEDIN_INVITE_QUOTA_EXCEEDED via the alternate error_code alias', () => {
		expect(classifyUnipileResponse(429, { error_code: 'invitation_limit_reached' })).toBe(
			'LINKEDIN_INVITE_QUOTA_EXCEEDED',
		)
	})

	it('detects LINKEDIN_ALREADY_CONNECTED via error_code on a 409', () => {
		expect(classifyUnipileResponse(409, { error_code: 'already_connected' })).toBe(
			'LINKEDIN_ALREADY_CONNECTED',
		)
	})

	it('detects LINKEDIN_ALREADY_CONNECTED via the pending-invitation alias', () => {
		expect(classifyUnipileResponse(400, { error_code: 'pending_invitation' })).toBe(
			'LINKEDIN_ALREADY_CONNECTED',
		)
	})

	it('reads error_code case-insensitively for the connect-request markers', () => {
		// Live Unipile occasionally shouts the code in uppercase; the marker
		// list is lowercase, so the classifier normalises before comparing.
		expect(classifyUnipileResponse(400, { error_code: 'INVITE_QUOTA_EXCEEDED' })).toBe(
			'LINKEDIN_INVITE_QUOTA_EXCEEDED',
		)
		expect(classifyUnipileResponse(409, { error_code: 'Already_Connected' })).toBe(
			'LINKEDIN_ALREADY_CONNECTED',
		)
	})

	it('returns null for a clean 2xx', () => {
		expect(
			classifyUnipileResponse(200, { id: 'msg-1', sent_at: '2026-08-31T12:00:00Z' }),
		).toBeNull()
	})

	// LINKEDIN_POST_TOO_LONG covers the two shapes Unipile v2 uses when
	// LinkedIn rejects an over-length post body: a body-level `error_code`
	// marker (preferred discriminator) and a plain 400 whose message names
	// the limit. Either surfaces the same wire code so the caller — a
	// Copywriter loop retrying the same draft — knows to shorten before
	// re-issuing.
	it('detects LINKEDIN_POST_TOO_LONG via error_code marker', () => {
		expect(classifyUnipileResponse(400, { error_code: 'post_too_long', message: 'nope' })).toBe(
			'LINKEDIN_POST_TOO_LONG',
		)
	})

	it('detects LINKEDIN_POST_TOO_LONG via message text when error_code is missing', () => {
		expect(
			classifyUnipileResponse(400, {
				message: 'Post body exceeds the maximum length of 3000 characters.',
			}),
		).toBe('LINKEDIN_POST_TOO_LONG')
	})

	it('marks LINKEDIN_POST_TOO_LONG as non-retryable', () => {
		expect(RETRY_POLICY_BY_CODE.LINKEDIN_POST_TOO_LONG).toBeNull()
	})
})

describe('LinkedInIntegrationError metadata', () => {
	it('carries the classification code + retryable flag', () => {
		const err = new LinkedInIntegrationError('RATE_LIMITED_UNIPILE', 'slow down')
		expect(err.code).toBe('RATE_LIMITED_UNIPILE')
		expect(err.retryable).toBe(true)
	})

	it('marks LINKEDIN_ACCOUNT_RESTRICTED as non-retryable', () => {
		const err = new LinkedInIntegrationError('LINKEDIN_ACCOUNT_RESTRICTED', 'do not retry')
		expect(err.retryable).toBe(false)
	})

	it('marks LINKEDIN_INVITE_QUOTA_EXCEEDED as non-retryable', () => {
		// Retrying invitation-quota errors burns more quota against the same
		// account and worsens the LinkedIn restriction risk.
		const err = new LinkedInIntegrationError('LINKEDIN_INVITE_QUOTA_EXCEEDED', 'weekly quota spent')
		expect(err.retryable).toBe(false)
	})

	it('marks LINKEDIN_ALREADY_CONNECTED as non-retryable', () => {
		const err = new LinkedInIntegrationError('LINKEDIN_ALREADY_CONNECTED', 'already invited')
		expect(err.retryable).toBe(false)
	})

	it('is recognized by isLinkedInIntegrationError', () => {
		const err = new LinkedInIntegrationError('INVALID_INPUT', 'bad')
		expect(isLinkedInIntegrationError(err)).toBe(true)
		expect(isLinkedInIntegrationError(new Error('boom'))).toBe(false)
	})
})

describe('RETRY_POLICY_BY_CODE', () => {
	it('has a null policy for every non-retryable class', () => {
		expect(RETRY_POLICY_BY_CODE.CREDENTIAL_NOT_CONNECTED).toBeNull()
		expect(RETRY_POLICY_BY_CODE.CREDENTIAL_REVOKED).toBeNull()
		expect(RETRY_POLICY_BY_CODE.LINKEDIN_ACCOUNT_RESTRICTED).toBeNull()
		expect(RETRY_POLICY_BY_CODE.INVALID_INPUT).toBeNull()
		expect(RETRY_POLICY_BY_CODE.LINKEDIN_INVITE_QUOTA_EXCEEDED).toBeNull()
		expect(RETRY_POLICY_BY_CODE.LINKEDIN_ALREADY_CONNECTED).toBeNull()
	})

	it('matches spec §4 for RATE_LIMITED_UNIPILE (base 2s, 3 attempts, ±25% jitter, cap 30s)', () => {
		const p = RETRY_POLICY_BY_CODE.RATE_LIMITED_UNIPILE
		expect(p).not.toBeNull()
		expect(p?.baseMs).toBe(2_000)
		expect(p?.maxAttempts).toBe(3)
		expect(p?.capMs).toBe(30_000)
		expect(p?.jitter).toBeCloseTo(0.25)
	})

	it('matches spec §4 for UNIPILE_UNAVAILABLE (base 3s, 3 attempts, cap 30s)', () => {
		const p = RETRY_POLICY_BY_CODE.UNIPILE_UNAVAILABLE
		expect(p).not.toBeNull()
		expect(p?.baseMs).toBe(3_000)
		expect(p?.maxAttempts).toBe(3)
		expect(p?.capMs).toBe(30_000)
	})

	it('covers every LinkedInErrorCode', () => {
		for (const code of LINKEDIN_ERROR_CODES) {
			expect(code in RETRY_POLICY_BY_CODE).toBe(true)
		}
	})
})

describe('computeBackoffMs', () => {
	it('doubles per attempt, no-jitter policy is deterministic', () => {
		const p = { maxAttempts: 3, baseMs: 3_000, capMs: 30_000, jitter: 0 }
		expect(computeBackoffMs(p, 0)).toBe(3_000)
		expect(computeBackoffMs(p, 1)).toBe(6_000)
		expect(computeBackoffMs(p, 2)).toBe(12_000)
	})

	it('caps at capMs', () => {
		const p = { maxAttempts: 5, baseMs: 3_000, capMs: 10_000, jitter: 0 }
		expect(computeBackoffMs(p, 10)).toBe(10_000)
	})

	it('applies jitter within ±jitter*raw', () => {
		const p = { maxAttempts: 3, baseMs: 2_000, capMs: 30_000, jitter: 0.25 }
		for (let i = 0; i < 50; i++) {
			const v = computeBackoffMs(p, 1) // raw = 4000, ±25% -> [3000, 5000]
			expect(v).toBeGreaterThanOrEqual(3_000)
			expect(v).toBeLessThanOrEqual(5_000)
		}
	})
})

describe('isAccountStatusRevoked', () => {
	it('flags DISCONNECTED and RESTRICTED', () => {
		expect(isAccountStatusRevoked('DISCONNECTED')).toBe(true)
		expect(isAccountStatusRevoked('RESTRICTED')).toBe(true)
		expect(isAccountStatusRevoked('disconnected')).toBe(true)
	})

	it('does not flag OK / CONNECTED / undefined', () => {
		expect(isAccountStatusRevoked('OK')).toBe(false)
		expect(isAccountStatusRevoked('CONNECTED')).toBe(false)
		expect(isAccountStatusRevoked(null)).toBe(false)
		expect(isAccountStatusRevoked(undefined)).toBe(false)
	})
})

describe('UNIPILE_RESTRICTED_MARKERS', () => {
	it('documents both known Unipile discriminators', () => {
		expect(UNIPILE_RESTRICTED_MARKERS.disconnectedAccountReasons).toContain('RESTRICTED')
		expect(UNIPILE_RESTRICTED_MARKERS.errorCodes).toContain('account_restricted')
	})
})

describe('UNIPILE_CONNECTION_REQUEST_MARKERS', () => {
	it('documents both connect-request error-code discriminators from the spec', () => {
		expect(UNIPILE_CONNECTION_REQUEST_MARKERS.inviteQuotaExceeded).toContain(
			'invite_quota_exceeded',
		)
		expect(UNIPILE_CONNECTION_REQUEST_MARKERS.alreadyConnected).toContain('already_connected')
	})
})
