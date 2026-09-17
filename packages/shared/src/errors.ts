export const ApiErrorCode = {
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	NOT_FOUND: 'NOT_FOUND',
	UNAUTHORIZED: 'UNAUTHORIZED',
	FORBIDDEN: 'FORBIDDEN',
	CONFLICT: 'CONFLICT',
	RATE_LIMITED: 'RATE_LIMITED',
	BAD_REQUEST: 'BAD_REQUEST',
	INTERNAL_ERROR: 'INTERNAL_ERROR',
	PLAN_CAP_EXCEEDED: 'PLAN_CAP_EXCEEDED',
	// Prepaid credit balance below the pre-session reserve — surfaces on the
	// same HTTP 402 as PLAN_CAP_EXCEEDED but carries a different error contract
	// (balance_cents / min_reserve_cents / topup_url) driven by
	// InsufficientCreditsError. See apps/dev/src/lib/llm-routing.ts.
	INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
	AUTH_REVOKED: 'AUTH_REVOKED',
	// Workspace-membership entitlement gates (distinct from PLAN_CAP_EXCEEDED,
	// which is token-usage-specific and returns 402). These are
	// authorization-style "not entitled to add more" failures and return 403,
	// matching how enterpriseGranted gate failures are already surfaced. See
	// apps/dev/src/lib/workspace-capacity.ts.
	SEAT_CAP_EXCEEDED: 'SEAT_CAP_EXCEEDED',
	OWNERSHIP_CAP_EXCEEDED: 'OWNERSHIP_CAP_EXCEEDED',
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
		case 429:
			return ApiErrorCode.RATE_LIMITED
		default:
			return ApiErrorCode.INTERNAL_ERROR
	}
}
