/**
 * Error envelope for the Drive write-path tools (google_drive__write_file,
 * google_drive__comment_on_document).
 *
 * Wire shape matches the other providers: { error: { code, message,
 * provider_status?, retry_after_ms?, hint? } }. Google's raw JSON never leaves
 * this module.
 */
export type DriveWriteErrorCode =
	| 'PERMISSION_DENIED'
	| 'SCOPE_INSUFFICIENT'
	| 'FILE_NOT_FOUND'
	| 'RATE_LIMIT_EXCEEDED'
	| 'QUOTA_EXCEEDED_USER'
	| 'QUOTA_EXCEEDED_PROJECT'
	| 'UPLOAD_FAILED'
	| 'RECONSENT_REQUIRED'
	| 'INVALID_INPUT'
	| 'PROVIDER_ERROR'

export interface DriveWriteErrorEnvelope {
	error: {
		code: DriveWriteErrorCode
		message: string
		provider_status?: number
		retry_after_ms?: number
		hint?: string
	}
}

export class DriveWriteError extends Error {
	readonly code: DriveWriteErrorCode
	readonly providerStatus?: number
	readonly retryAfterMs?: number
	readonly hint?: string

	constructor(params: {
		code: DriveWriteErrorCode
		message: string
		providerStatus?: number
		retryAfterMs?: number
		hint?: string
	}) {
		super(params.message)
		this.name = 'DriveWriteError'
		this.code = params.code
		this.providerStatus = params.providerStatus
		this.retryAfterMs = params.retryAfterMs
		this.hint = params.hint
	}

	toEnvelope(): DriveWriteErrorEnvelope {
		return {
			error: {
				code: this.code,
				message: this.message,
				...(this.providerStatus !== undefined && { provider_status: this.providerStatus }),
				...(this.retryAfterMs !== undefined && { retry_after_ms: this.retryAfterMs }),
				...(this.hint !== undefined && { hint: this.hint }),
			},
		}
	}
}

export function isDriveWriteError(err: unknown): err is DriveWriteError {
	return err instanceof DriveWriteError
}

export function invalidInput(message: string, hint?: string): DriveWriteError {
	return new DriveWriteError({ code: 'INVALID_INPUT', message, hint })
}

/** The one message every terminal resumable-upload failure carries. */
export const RESTART_UPLOAD_HINT =
	'Restart the upload from the beginning with a fresh write_file call. Resumable-session state is held in memory on the API process and cannot be recovered.'

interface GoogleErrorBody {
	error?: {
		code?: number
		message?: string
		status?: string
		errors?: Array<{ reason?: string; message?: string }>
		details?: Array<{ reason?: string }>
	}
}

const RATE_REASONS = new Set([
	'rateLimitExceeded',
	'userRateLimitExceeded',
	'sharingRateLimitExceeded',
])
const PROJECT_QUOTA_REASONS = new Set(['dailyLimitExceeded', 'quotaExceeded'])

function parseBody(bodyText: string): GoogleErrorBody {
	try {
		return JSON.parse(bodyText) as GoogleErrorBody
	} catch {
		return {}
	}
}

function parseRetryAfterMs(header: string | null | undefined): number | undefined {
	if (!header) return undefined
	const seconds = Number(header)
	return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined
}

/**
 * Map a non-2xx Google API response (Drive, Docs or Sheets) to a DriveWriteError.
 * Scope problems are checked before file-permission problems because Google
 * reports both as 403.
 */
export function classifyDriveApiError(
	status: number,
	bodyText: string,
	headers?: { get(name: string): string | null },
): DriveWriteError {
	const parsed = parseBody(bodyText)
	const err = parsed.error
	const message = err?.message ?? `Google API returned HTTP ${status}.`
	const reasons = [
		...(err?.errors ?? []).map((e) => e.reason),
		...(err?.details ?? []).map((d) => d.reason),
	].filter((r): r is string => typeof r === 'string')
	const retryAfterMs = parseRetryAfterMs(headers?.get('retry-after'))
	const wwwAuth = headers?.get('www-authenticate') ?? ''

	if (status === 401) {
		return new DriveWriteError({
			code: 'RECONSENT_REQUIRED',
			message: 'Google rejected the connected account credentials.',
			providerStatus: status,
			hint: 'Ask a workspace member to reconnect Google Drive in Settings → Integrations.',
		})
	}

	if (status === 403 || status === 400) {
		const scopeProblem =
			reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
			/insufficient_scope/i.test(wwwAuth) ||
			/insufficient authentication scopes/i.test(message)
		if (scopeProblem) {
			return new DriveWriteError({
				code: 'SCOPE_INSUFFICIENT',
				message: 'The connected Google account has not granted the scope this call needs.',
				providerStatus: status,
				hint: 'Reconnect Google Drive and accept the Drive scope.',
			})
		}
	}

	if (status === 403) {
		if (reasons.some((r) => RATE_REASONS.has(r))) {
			return new DriveWriteError({
				code: 'RATE_LIMIT_EXCEEDED',
				message: 'Google rate limit reached for this user.',
				providerStatus: status,
				retryAfterMs,
			})
		}
		if (reasons.includes('storageQuotaExceeded')) {
			return new DriveWriteError({
				code: 'QUOTA_EXCEEDED_USER',
				message: "The connected account's Drive storage is full.",
				providerStatus: status,
			})
		}
		if (reasons.some((r) => PROJECT_QUOTA_REASONS.has(r))) {
			return new DriveWriteError({
				code: 'QUOTA_EXCEEDED_PROJECT',
				message: 'The Google project quota is exhausted.',
				providerStatus: status,
			})
		}
		return new DriveWriteError({
			code: 'PERMISSION_DENIED',
			message: 'The connected Google account does not have permission for this file or folder.',
			providerStatus: status,
			hint: 'Share the file or folder with the connected account with edit (or comment) access.',
		})
	}

	if (status === 404) {
		return new DriveWriteError({
			code: 'FILE_NOT_FOUND',
			message: 'The file or folder was not found, or is not visible to the connected account.',
			providerStatus: status,
		})
	}

	if (status === 429) {
		return new DriveWriteError({
			code: 'RATE_LIMIT_EXCEEDED',
			message: 'Google rate limit reached.',
			providerStatus: status,
			retryAfterMs,
		})
	}

	return new DriveWriteError({ code: 'PROVIDER_ERROR', message, providerStatus: status })
}
