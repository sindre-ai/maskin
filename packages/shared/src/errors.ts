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
	code: ApiErrorCode | string,
	message: string,
	details?: ApiErrorDetail[],
	suggestion?: string,
): ApiErrorResponse {
	return {
		error: {
			code: code as ApiErrorCode,
			message,
			...(details?.length ? { details } : {}),
			...(suggestion ? { suggestion } : {}),
		},
	}
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
