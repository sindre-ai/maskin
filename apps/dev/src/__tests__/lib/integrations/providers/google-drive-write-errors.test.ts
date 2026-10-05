import { describe, expect, it } from 'vitest'
import { classifyDriveApiError } from '../../../../lib/integrations/providers/google-drive/write-errors'

const body = (status: number, message: string, reason?: string, details?: object[]) =>
	JSON.stringify({
		error: {
			code: status,
			message,
			...(reason && { errors: [{ reason }] }),
			...(details && { details }),
		},
	})

describe('classifyDriveApiError', () => {
	it('403 on a file the account cannot write is PERMISSION_DENIED', () => {
		const err = classifyDriveApiError(403, body(403, 'no access', 'insufficientFilePermissions'))
		expect(err.code).toBe('PERMISSION_DENIED')
		expect(err.toEnvelope().error.provider_status).toBe(403)
	})

	it('a missing scope is SCOPE_INSUFFICIENT, not PERMISSION_DENIED (ErrorInfo reason)', () => {
		const err = classifyDriveApiError(
			403,
			body(403, 'Request had insufficient authentication scopes.', 'insufficientPermissions', [
				{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
			]),
		)
		expect(err.code).toBe('SCOPE_INSUFFICIENT')
	})

	it('a missing scope is also read off the WWW-Authenticate header', () => {
		const headers = new Headers({ 'www-authenticate': 'Bearer error="insufficient_scope"' })
		expect(classifyDriveApiError(403, body(403, 'Forbidden'), headers).code).toBe(
			'SCOPE_INSUFFICIENT',
		)
	})

	it('maps rate limits, quotas, 404 and 401', () => {
		expect(classifyDriveApiError(403, body(403, 'slow down', 'userRateLimitExceeded')).code).toBe(
			'RATE_LIMIT_EXCEEDED',
		)
		const headers = new Headers({ 'retry-after': '3' })
		const limited = classifyDriveApiError(429, '', headers)
		expect(limited.code).toBe('RATE_LIMIT_EXCEEDED')
		expect(limited.retryAfterMs).toBe(3000)
		expect(classifyDriveApiError(403, body(403, 'full', 'storageQuotaExceeded')).code).toBe(
			'QUOTA_EXCEEDED_USER',
		)
		expect(classifyDriveApiError(403, body(403, 'daily', 'dailyLimitExceeded')).code).toBe(
			'QUOTA_EXCEEDED_PROJECT',
		)
		expect(classifyDriveApiError(404, body(404, 'File not found: x')).code).toBe('FILE_NOT_FOUND')
		expect(classifyDriveApiError(401, '').code).toBe('RECONSENT_REQUIRED')
	})

	it('never leaks Google raw JSON for unknown failures', () => {
		const err = classifyDriveApiError(500, 'not json at all')
		expect(err.code).toBe('PROVIDER_ERROR')
		expect(JSON.stringify(err.toEnvelope())).not.toContain('not json')
	})
})
