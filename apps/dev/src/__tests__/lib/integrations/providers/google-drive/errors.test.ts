import { describe, expect, it } from 'vitest'
import {
	DriveError,
	classifyDriveError,
	isDriveError,
} from '../../../../../lib/integrations/providers/google-drive/errors'

const body = (reason: string, message = 'msg') =>
	JSON.stringify({ error: { message, errors: [{ reason }] } })

describe('classifyDriveError', () => {
	it.each([
		[401, '', undefined, 'RECONSENT_REQUIRED'],
		[404, body('notFound'), undefined, 'FILE_NOT_FOUND'],
		[403, body('insufficientPermissions'), undefined, 'SCOPE_INSUFFICIENT'],
		[403, body('forbidden'), undefined, 'PERMISSION_DENIED'],
		[403, body('userRateLimitExceeded'), undefined, 'QUOTA_EXCEEDED_USER'],
		[403, body('storageQuotaExceeded'), undefined, 'QUOTA_EXCEEDED_USER'],
		[403, body('quotaExceeded', 'project quota exceeded'), undefined, 'QUOTA_EXCEEDED_PROJECT'],
		[403, body('rateLimitExceeded'), undefined, 'RATE_LIMIT_EXCEEDED'],
		[429, '', undefined, 'RATE_LIMIT_EXCEEDED'],
		[400, body('invalid', 'Invalid Value'), undefined, 'INVALID_INPUT'],
		[500, '<html>oops</html>', undefined, 'PROVIDER_ERROR'],
		[418, '', undefined, 'PROVIDER_ERROR'],
	])('status %s -> %s', (status, bodyText, retryAfterHeader, expected) => {
		expect(classifyDriveError({ status, bodyText, retryAfterHeader }).code).toBe(expected)
	})

	it('carries Retry-After (seconds) on a rate limit as retry_after_ms', () => {
		const e = classifyDriveError({ status: 429, bodyText: '', retryAfterHeader: '3' })
		expect(e.retryAfterMs).toBe(3000)
		expect(e.toEnvelope()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', retry_after_ms: 3000 })
	})

	it("never copies Google's raw body into the envelope for a classified status", () => {
		const e = classifyDriveError({ status: 404, bodyText: body('notFound', 'SECRET-DETAIL') })
		expect(JSON.stringify(e.toEnvelope())).not.toContain('SECRET-DETAIL')
	})

	it('isDriveError narrows DriveError only', () => {
		expect(isDriveError(new DriveError({ code: 'FILE_TRASHED', message: 'x' }))).toBe(true)
		expect(isDriveError(new Error('x'))).toBe(false)
	})
})
