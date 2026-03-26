import { describe, expect, it } from 'vitest'
import { ApiErrorCode, createApiError, mapStatusToCode } from '../errors'

describe('createApiError', () => {
	it('returns error response with code and message', () => {
		const result = createApiError(ApiErrorCode.NOT_FOUND, 'Object not found')
		expect(result.error.code).toBe('NOT_FOUND')
		expect(result.error.message).toBe('Object not found')
	})

	it('includes details when provided', () => {
		const details = [{ field: 'email', message: 'Invalid format' }]
		const result = createApiError(ApiErrorCode.VALIDATION_ERROR, 'Validation failed', details)
		expect(result.error.details).toEqual(details)
	})

	it('omits details when empty array', () => {
		const result = createApiError(ApiErrorCode.BAD_REQUEST, 'Bad request', [])
		expect(result.error.details).toBeUndefined()
	})

	it('omits details when undefined', () => {
		const result = createApiError(ApiErrorCode.BAD_REQUEST, 'Bad request')
		expect(result.error.details).toBeUndefined()
	})

	it('includes suggestion when provided', () => {
		const result = createApiError(
			ApiErrorCode.UNAUTHORIZED,
			'Invalid API key',
			undefined,
			'Check your API key format',
		)
		expect(result.error.suggestion).toBe('Check your API key format')
	})

	it('omits suggestion when undefined', () => {
		const result = createApiError(ApiErrorCode.UNAUTHORIZED, 'Unauthorized')
		expect(result.error.suggestion).toBeUndefined()
	})

	it('includes both details and suggestion', () => {
		const details = [{ field: 'name', message: 'Required' }]
		const result = createApiError(
			ApiErrorCode.VALIDATION_ERROR,
			'Failed',
			details,
			'Provide all required fields',
		)
		expect(result.error.details).toHaveLength(1)
		expect(result.error.suggestion).toBe('Provide all required fields')
	})
})

describe('mapStatusToCode', () => {
	it('maps 400 to BAD_REQUEST', () => {
		expect(mapStatusToCode(400)).toBe(ApiErrorCode.BAD_REQUEST)
	})

	it('maps 401 to UNAUTHORIZED', () => {
		expect(mapStatusToCode(401)).toBe(ApiErrorCode.UNAUTHORIZED)
	})

	it('maps 403 to FORBIDDEN', () => {
		expect(mapStatusToCode(403)).toBe(ApiErrorCode.FORBIDDEN)
	})

	it('maps 404 to NOT_FOUND', () => {
		expect(mapStatusToCode(404)).toBe(ApiErrorCode.NOT_FOUND)
	})

	it('maps 409 to CONFLICT', () => {
		expect(mapStatusToCode(409)).toBe(ApiErrorCode.CONFLICT)
	})

	it('maps 500 to INTERNAL_ERROR', () => {
		expect(mapStatusToCode(500)).toBe(ApiErrorCode.INTERNAL_ERROR)
	})

	it('maps unknown status to INTERNAL_ERROR', () => {
		expect(mapStatusToCode(418)).toBe(ApiErrorCode.INTERNAL_ERROR)
		expect(mapStatusToCode(503)).toBe(ApiErrorCode.INTERNAL_ERROR)
	})
})
