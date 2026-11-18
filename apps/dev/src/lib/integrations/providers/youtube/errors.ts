/**
 * Normalized error for every youtube__ tool. Carries a machine-actionable code plus the HTTP
 * status, Google's error reason and the integration id, and nothing else: response bodies never
 * go into an error, a log line or a tool result (policy item P4), because they hold YouTube data.
 */
export type YoutubeErrorCode =
	| 'RECONSENT_REQUIRED'
	| 'NOT_CONNECTED'
	| 'INTEGRATION_REQUIRED'
	| 'QUOTA_EXHAUSTED'
	| 'WORKSPACE_QUOTA_EXHAUSTED'
	| 'RATE_LIMITED'
	| 'NOT_FOUND'
	| 'PERMISSION_DENIED'
	| 'INVALID_INPUT'
	| 'PROVIDER_ERROR'

/** One connected Google account, as listed when a tool call must say which one it means. */
export interface YoutubeConnectionRef {
	integration_id: string
	/** The connected Google account (the integration's external id). Not channel data. */
	account: string | null
}

export interface YoutubeErrorPayload {
	code: YoutubeErrorCode
	message: string
	provider_status?: number
	reason?: string
	integration_id?: string
	hint?: string
	/** Set on INTEGRATION_REQUIRED: the connections the caller can pick from. */
	connections?: YoutubeConnectionRef[]
}

export class YoutubeError extends Error {
	readonly code: YoutubeErrorCode
	readonly providerStatus?: number
	readonly reason?: string
	readonly integrationId?: string
	readonly hint?: string
	readonly connections?: YoutubeConnectionRef[]

	constructor(payload: YoutubeErrorPayload) {
		super(payload.message)
		this.name = 'YoutubeError'
		this.code = payload.code
		this.providerStatus = payload.provider_status
		this.reason = payload.reason
		this.integrationId = payload.integration_id
		this.hint = payload.hint
		this.connections = payload.connections
	}

	toPayload(): YoutubeErrorPayload {
		const out: YoutubeErrorPayload = { code: this.code, message: this.message }
		if (this.providerStatus !== undefined) out.provider_status = this.providerStatus
		if (this.reason !== undefined) out.reason = this.reason
		if (this.integrationId !== undefined) out.integration_id = this.integrationId
		if (this.hint !== undefined) out.hint = this.hint
		if (this.connections !== undefined) out.connections = this.connections
		return out
	}
}

export function isYoutubeError(err: unknown): err is YoutubeError {
	return err instanceof YoutubeError
}

/**
 * Pull Google's error reason (for example quotaExceeded) out of an error body, and nothing else.
 * Only the short reason token is kept; the message, which can echo request data, is dropped.
 */
export function extractGoogleReason(bodyText: string): string | undefined {
	try {
		const parsed = JSON.parse(bodyText) as { error?: { errors?: Array<{ reason?: unknown }> } }
		const reason = parsed.error?.errors?.[0]?.reason
		if (typeof reason === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(reason)) return reason
	} catch {
		// Not JSON (Google sometimes answers HTML on 5xx). No reason to report.
	}
	return undefined
}

/** Map a failed Google response to a YoutubeError. The body is read for the reason only. */
export function classifyYoutubeError(
	status: number,
	bodyText: string,
	integrationId: string,
	retryAfterHeader?: string | null,
): YoutubeError {
	const reason = extractGoogleReason(bodyText)
	const base = { provider_status: status, reason, integration_id: integrationId }
	if (status === 401) {
		return new YoutubeError({
			...base,
			code: 'RECONSENT_REQUIRED',
			message: 'Google rejected the access token. The connected YouTube account must reconnect.',
			hint: 'Ask a workspace member to reconnect YouTube in Settings → Integrations.',
		})
	}
	if (status === 403 && reason && /quota|rateLimit/i.test(reason)) {
		return new YoutubeError({
			...base,
			code: 'RATE_LIMITED',
			message: 'Google reports the YouTube API quota is used up for today.',
			hint: retryAfterHeader ? `Retry after ${retryAfterHeader} seconds.` : 'Try again tomorrow.',
		})
	}
	if (status === 403) {
		return new YoutubeError({
			...base,
			code: 'PERMISSION_DENIED',
			message: 'Google refused the YouTube API call.',
		})
	}
	if (status === 404) {
		return new YoutubeError({ ...base, code: 'NOT_FOUND', message: 'YouTube resource not found.' })
	}
	if (status === 429) {
		return new YoutubeError({
			...base,
			code: 'RATE_LIMITED',
			message: 'Google rate-limited the YouTube API call.',
		})
	}
	return new YoutubeError({
		...base,
		code: 'PROVIDER_ERROR',
		message: `Google returned ${status} on a YouTube API call.`,
	})
}
