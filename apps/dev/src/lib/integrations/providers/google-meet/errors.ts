/**
 * Normalised error envelope for the google-meet write-path MCP tools (bet 947e
 * · task 824f). Every tool returns Google's raw failure as a shaped
 * `MeetToolError` so the LLM never sees Google's own JSON — a raw `error.status`
 * of `PERMISSION_DENIED` in the response body would send the model into a
 * retry loop that never resolves.
 *
 * The code set is closed and named in the task's acceptance criteria:
 *   RECONSENT_REQUIRED · PROVIDER_ERROR · NOT_FOUND · RATE_LIMITED ·
 *   MEET_REQUIRES_WORKSPACE · MEETING_NOT_OWNED_BY_ACTOR
 */

export type MeetErrorCode =
	| 'RECONSENT_REQUIRED'
	| 'PROVIDER_ERROR'
	| 'NOT_FOUND'
	| 'RATE_LIMITED'
	| 'MEET_REQUIRES_WORKSPACE'
	| 'MEETING_NOT_OWNED_BY_ACTOR'

export interface MeetErrorEnvelope {
	error: {
		code: MeetErrorCode
		message: string
		/** Google's raw HTTP status when the failure originated at Google. */
		provider_status?: number
		/** Milliseconds to wait before retrying — populated for RATE_LIMITED. */
		retry_after_ms?: number
		/** Agent-actionable next step, e.g. "Ask the meeting host to reconnect Google." */
		hint?: string
	}
}

export class MeetToolError extends Error {
	readonly code: MeetErrorCode
	readonly providerStatus?: number
	readonly retryAfterMs?: number
	readonly hint?: string

	constructor(
		code: MeetErrorCode,
		message: string,
		opts: { providerStatus?: number; retryAfterMs?: number; hint?: string } = {},
	) {
		super(message)
		this.name = 'MeetToolError'
		this.code = code
		this.providerStatus = opts.providerStatus
		this.retryAfterMs = opts.retryAfterMs
		this.hint = opts.hint
	}

	toEnvelope(): MeetErrorEnvelope {
		const error: MeetErrorEnvelope['error'] = { code: this.code, message: this.message }
		if (this.providerStatus !== undefined) error.provider_status = this.providerStatus
		if (this.retryAfterMs !== undefined) error.retry_after_ms = this.retryAfterMs
		if (this.hint !== undefined) error.hint = this.hint
		return { error }
	}
}

interface GoogleErrorBody {
	error?: {
		code?: number
		message?: string
		status?: string
		details?: Array<{ reason?: string; '@type'?: string } & Record<string, unknown>>
	}
}

/**
 * Classify a Google API failure into a Meet-tool error envelope. The
 * `contextHint` tail carries a code-specific default (\"reconnect Google\",
 * \"upgrade to Workspace\", ...) so the agent gets one actionable next step
 * even when Google's message text is unhelpful.
 *
 * `MEET_REQUIRES_WORKSPACE` is inferred from Google's `error.status` +
 * `error.details[].reason` — a free consumer account trying to hit
 * `spaces.create` returns 403 with a reason that mentions consumer or
 * non-Workspace tenancy. Falling back to `RECONSENT_REQUIRED` for a generic
 * 403 keeps the agent from over-triggering the paid-tier hint.
 */
export function classifyGoogleFailure(
	httpStatus: number,
	body: GoogleErrorBody | undefined,
	opts: { retryAfterHeader?: string | null; opContext?: string } = {},
): MeetToolError {
	const message = body?.error?.message ?? `Google API returned HTTP ${httpStatus}`
	const status = body?.error?.status
	const reasons = (body?.error?.details ?? [])
		.map((d) => (typeof d.reason === 'string' ? d.reason.toLowerCase() : ''))
		.filter(Boolean)

	if (httpStatus === 401) {
		return new MeetToolError('RECONSENT_REQUIRED', 'Google access token was rejected.', {
			providerStatus: httpStatus,
			hint: 'Ask the meeting host to reconnect Google — the stored token is no longer valid.',
		})
	}

	if (httpStatus === 403) {
		const reasonBlob = `${status ?? ''} ${reasons.join(' ')} ${message}`.toLowerCase()
		if (
			reasonBlob.includes('workspace') ||
			reasonBlob.includes('consumer') ||
			reasonBlob.includes('not eligible') ||
			reasonBlob.includes('paid')
		) {
			return new MeetToolError(
				'MEET_REQUIRES_WORKSPACE',
				'Google Meet space provisioning is not available on this account.',
				{
					providerStatus: httpStatus,
					hint: 'Free / consumer Google accounts cannot provision Meet spaces via API — the calling actor needs a Google Workspace account.',
				},
			)
		}

		if (reasonBlob.includes('scope') || reasonBlob.includes('insufficient')) {
			return new MeetToolError('RECONSENT_REQUIRED', 'Required Meet OAuth scope is not granted.', {
				providerStatus: httpStatus,
				hint: 'The meeting host must reconnect Google and grant meetings.space.created.',
			})
		}

		return new MeetToolError('MEETING_NOT_OWNED_BY_ACTOR', message || 'Access denied by Google.', {
			providerStatus: httpStatus,
			hint: opts.opContext ?? 'The resolved actor does not own the Meet resource.',
		})
	}

	if (httpStatus === 404) {
		return new MeetToolError('NOT_FOUND', message || 'Google resource not found.', {
			providerStatus: httpStatus,
			hint: opts.opContext,
		})
	}

	if (httpStatus === 429) {
		const retryAfterMs = parseRetryAfterHeader(opts.retryAfterHeader)
		return new MeetToolError('RATE_LIMITED', 'Google API rate limit reached.', {
			providerStatus: httpStatus,
			retryAfterMs,
			hint: retryAfterMs
				? `Retry after ${Math.round(retryAfterMs / 1000)}s.`
				: 'Retry after a short backoff.',
		})
	}

	return new MeetToolError('PROVIDER_ERROR', message, {
		providerStatus: httpStatus,
		hint: 'Google returned an unexpected error — retry once, then surface to a human if it recurs.',
	})
}

function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
	if (!value) return undefined
	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
	const date = Date.parse(value)
	if (!Number.isNaN(date)) {
		const ms = date - Date.now()
		return ms > 0 ? ms : 0
	}
	return undefined
}
