/**
 * Normalized error envelope shared by every google_drive__* MCP tool. Callers
 * get a machine-actionable `code` plus the raw provider status; Google's raw
 * JSON never bleeds through. The tag set is the one in the Drive tech spec §5
 * (common error tags), reused by the sibling tool tasks.
 *
 * LARGE_FILE_STREAMED_TO_STORAGE is informational, not an error: the download
 * task returns it as a note, never throws it. It lives in the same closed enum
 * so agents key on one vocabulary.
 */
export type DriveErrorCode =
	| 'FILE_NOT_FOUND'
	| 'FILE_TRASHED'
	| 'PERMISSION_DENIED'
	| 'SCOPE_INSUFFICIENT'
	| 'RATE_LIMIT_EXCEEDED'
	| 'QUOTA_EXCEEDED_USER'
	| 'QUOTA_EXCEEDED_PROJECT'
	| 'UPLOAD_FAILED'
	| 'EXPORT_FORMAT_UNSUPPORTED'
	| 'LARGE_FILE_STREAMED_TO_STORAGE'
	// Not Google-originated: no live grant for this workspace, or the grant
	// was revoked. The agent should ask a human to reconnect.
	| 'INTEGRATION_MISSING'
	| 'RECONSENT_REQUIRED'
	| 'INVALID_INPUT'
	| 'PROVIDER_ERROR'

export interface DriveErrorPayload {
	code: DriveErrorCode
	message: string
	provider_status?: number
	retry_after_ms?: number
	hint?: string
}

export class DriveError extends Error {
	readonly code: DriveErrorCode
	readonly providerStatus?: number
	readonly retryAfterMs?: number
	readonly hint?: string

	constructor(payload: DriveErrorPayload) {
		super(payload.message)
		this.name = 'DriveError'
		this.code = payload.code
		this.providerStatus = payload.provider_status
		this.retryAfterMs = payload.retry_after_ms
		this.hint = payload.hint
	}

	toEnvelope(): DriveErrorPayload {
		const out: DriveErrorPayload = { code: this.code, message: this.message }
		if (this.providerStatus !== undefined) out.provider_status = this.providerStatus
		if (this.retryAfterMs !== undefined) out.retry_after_ms = this.retryAfterMs
		if (this.hint !== undefined) out.hint = this.hint
		return out
	}
}

export function isDriveError(err: unknown): err is DriveError {
	return err instanceof DriveError
}

interface GoogleErrorBody {
	error?: {
		message?: string
		status?: string
		errors?: Array<{ reason?: string; message?: string }>
	}
}

/**
 * Map a Google Drive HTTP status + body to a DriveError. Google signals the
 * interesting cases through `error.errors[].reason`, not the status alone: a 403
 * is a rate limit, a quota, a missing scope or a plain permission error
 * depending on the reason.
 */
export function classifyDriveError(params: {
	status: number
	bodyText: string
	retryAfterHeader?: string | null
}): DriveError {
	const { status, bodyText, retryAfterHeader } = params
	let body: GoogleErrorBody | undefined
	try {
		body = JSON.parse(bodyText) as GoogleErrorBody
	} catch {
		body = undefined
	}
	const reasons = (body?.error?.errors ?? []).map((e) => (e.reason ?? '').toLowerCase())
	const providerMessage = body?.error?.message ?? bodyText.slice(0, 300)
	const has = (...needles: string[]) => needles.some((n) => reasons.includes(n))
	const bodyLower = bodyText.toLowerCase()

	if (status === 401) {
		return new DriveError({
			code: 'RECONSENT_REQUIRED',
			message: 'Google rejected the access token. The connected Drive account must reconnect.',
			provider_status: status,
			hint: 'Ask a workspace member to reconnect Google Drive in Settings → Integrations.',
		})
	}

	if (status === 403 || status === 429) {
		if (
			has('insufficientpermissions') ||
			/insufficient (authentication )?scopes?/i.test(bodyText)
		) {
			return new DriveError({
				code: 'SCOPE_INSUFFICIENT',
				message: 'The connected Google grant does not include the scope this call needs.',
				provider_status: status,
				hint: 'Ask a workspace member to reconnect Google Drive and accept the full consent.',
			})
		}
		if (has('storagequotaexceeded', 'quotaexceeded') && bodyLower.includes('project')) {
			return new DriveError({
				code: 'QUOTA_EXCEEDED_PROJECT',
				message: 'The Maskin Google Cloud project is out of Drive API quota.',
				provider_status: status,
			})
		}
		if (has('userratelimitexceeded', 'storagequotaexceeded', 'dailylimitexceeded')) {
			return new DriveError({
				code: 'QUOTA_EXCEEDED_USER',
				message: 'This Google account has hit its Drive API quota.',
				provider_status: status,
				retry_after_ms: parseRetryAfter(retryAfterHeader),
			})
		}
		if (status === 429 || has('ratelimitexceeded', 'sharingratelimitexceeded')) {
			return new DriveError({
				code: 'RATE_LIMIT_EXCEEDED',
				message: 'Google rate-limited the Drive API call.',
				provider_status: status,
				retry_after_ms: parseRetryAfter(retryAfterHeader),
			})
		}
		return new DriveError({
			code: 'PERMISSION_DENIED',
			message: 'The connected Google account cannot access this Drive resource.',
			provider_status: status,
		})
	}

	if (status === 404) {
		return new DriveError({
			code: 'FILE_NOT_FOUND',
			message: 'Drive file or folder not found, or not visible to the connected account.',
			provider_status: status,
		})
	}

	if (status === 400 && /invalid value|invalid query|invalid_query/i.test(providerMessage)) {
		return new DriveError({
			code: 'INVALID_INPUT',
			message: `Drive rejected the request: ${providerMessage.slice(0, 200)}`,
			provider_status: status,
			hint: 'Check the Drive query syntax, page token, or folder id.',
		})
	}

	return new DriveError({
		code: 'PROVIDER_ERROR',
		message:
			status >= 500
				? `Google returned ${status} on a Drive API call.`
				: `Unexpected Google Drive API status ${status}.`,
		provider_status: status,
	})
}

/** Retry-After is either delta-seconds or an HTTP-date; support both. */
function parseRetryAfter(header?: string | null): number | undefined {
	if (!header) return undefined
	const asNumber = Number(header)
	if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000)
	const asDate = Date.parse(header)
	if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
	return undefined
}
