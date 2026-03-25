import { z } from '@hono/zod-openapi'
import type { ZodError, ZodIssue } from 'zod'

export const ApiErrorCode = {
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	NOT_FOUND: 'NOT_FOUND',
	UNAUTHORIZED: 'UNAUTHORIZED',
	FORBIDDEN: 'FORBIDDEN',
	CONFLICT: 'CONFLICT',
	BAD_REQUEST: 'BAD_REQUEST',
	INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode]

export interface ApiErrorDetail {
	field: string
	message: string
	expected?: string
	received?: string
}

export interface ApiErrorResponse {
	error: {
		code: ApiErrorCode
		message: string
		details?: ApiErrorDetail[]
		suggestion?: string
	}
}

export function createApiError(
	code: ApiErrorCode,
	message: string,
	details?: ApiErrorDetail[],
	suggestion?: string,
): ApiErrorResponse {
	return {
		error: {
			code,
			message,
			...(details?.length ? { details } : {}),
			...(suggestion ? { suggestion } : {}),
		},
	}
}

function formatZodIssue(issue: ZodIssue): ApiErrorDetail {
	const field = issue.path.length > 0 ? issue.path.join('.') : '_root'
	const detail: ApiErrorDetail = {
		field,
		message: issue.message,
	}

	if (issue.code === 'invalid_type') {
		detail.expected = issue.expected
		detail.received = issue.received
	} else if (issue.code === 'invalid_enum_value') {
		detail.expected = issue.options.map((o) => `'${o}'`).join(' | ')
		detail.received = String(issue.received)
	} else if (issue.code === 'invalid_union') {
		// Simplify union errors to the most relevant message
		detail.message = `Invalid value: ${issue.message}`
	} else if (issue.code === 'invalid_string') {
		if (issue.validation === 'uuid') {
			detail.expected = 'UUID format (e.g. 550e8400-e29b-41d4-a716-446655440000)'
		} else if (issue.validation === 'email') {
			detail.expected = 'valid email address'
		} else if (typeof issue.validation === 'string') {
			detail.expected = issue.validation
		}
	} else if (issue.code === 'too_small') {
		detail.expected = `minimum ${issue.type === 'string' ? 'length' : 'value'} ${issue.minimum}`
	} else if (issue.code === 'too_big') {
		detail.expected = `maximum ${issue.type === 'string' ? 'length' : 'value'} ${issue.maximum}`
	}

	return detail
}

export function formatZodError(error: ZodError): ApiErrorDetail[] {
	return error.issues.map(formatZodIssue)
}

export function mapStatusToCode(status: number): ApiErrorCode {
	switch (status) {
		case 400:
			return ApiErrorCode.BAD_REQUEST
		case 401:
			return ApiErrorCode.UNAUTHORIZED
		case 403:
			return ApiErrorCode.FORBIDDEN
		case 404:
			return ApiErrorCode.NOT_FOUND
		case 409:
			return ApiErrorCode.CONFLICT
		default:
			return ApiErrorCode.INTERNAL_ERROR
	}
}

/** Zod schema for OpenAPI documentation of structured error responses */
export const apiErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z
			.array(
				z.object({
					field: z.string(),
					message: z.string(),
					expected: z.string().optional(),
					received: z.string().optional(),
				}),
			)
			.optional(),
		suggestion: z.string().optional(),
	}),
})
