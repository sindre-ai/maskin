export const ApiErrorCode = {
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	NOT_FOUND: 'NOT_FOUND',
	UNAUTHORIZED: 'UNAUTHORIZED',
	FORBIDDEN: 'FORBIDDEN',
	CONFLICT: 'CONFLICT',
	RATE_LIMITED: 'RATE_LIMITED',
	BAD_REQUEST: 'BAD_REQUEST',
	INTERNAL_ERROR: 'INTERNAL_ERROR',
	// Integration auth lifecycle. `auth_revoked` is returned by any integration
	// tool when the upstream grant has been revoked (Google `invalid_grant`,
	// Google 401 on a data call, etc.). The provider integration row also
	// flips from `active` to `revoked` on the same call so a second invocation
	// short-circuits without re-hitting the upstream.
	AUTH_REVOKED: 'auth_revoked',
	// Google Calendar write surface — distinct codes so the agent can act on
	// each one without leaking the raw Google body. 412 means the event
	// changed between the agent's read and the write attempt; the tool must
	// not mutate any fields on this branch. 403 means the caller isn't the
	// event organizer/attendee. 404 means the event was deleted upstream.
	EVENT_CONFLICT: 'event_conflict',
	EVENT_FORBIDDEN: 'event_forbidden',
	EVENT_GONE: 'event_gone',
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
