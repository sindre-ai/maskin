/**
 * Normalized error envelope shared by every google-meet MCP tool.
 *
 * Callers get a machine-actionable `code` plus the raw provider status;
 * Google's raw JSON never bleeds through.
 */
export type MeetErrorCode =
	| 'PERMISSION_DENIED'
	| 'NOT_FOUND'
	| 'RATE_LIMITED'
	| 'ARTEFACT_PENDING'
	| 'RECONSENT_REQUIRED'
	| 'PROVIDER_ERROR'
	| 'MEETING_NOT_OWNED_BY_ACTOR'
	| 'MEET_REQUIRES_WORKSPACE'
	| 'INTEGRATION_MISSING'
	| 'INVALID_INPUT'

export interface MeetErrorEnvelope {
	error: {
		code: MeetErrorCode
		message: string
		provider_status?: number
		retry_after_ms?: number
		hint?: string
	}
}

export class MeetToolError extends Error {
	readonly envelope: MeetErrorEnvelope

	constructor(envelope: MeetErrorEnvelope) {
		super(envelope.error.message)
		this.name = 'MeetToolError'
		this.envelope = envelope
	}
}

export function makeMeetError(
	code: MeetErrorCode,
	message: string,
	extra?: { provider_status?: number; retry_after_ms?: number; hint?: string },
): MeetToolError {
	return new MeetToolError({ error: { code, message, ...(extra ?? {}) } })
}

/**
 * Map a Google API HTTP status + body to the normalized code. Never surfaces
 * Google's raw JSON — the free-text message is deliberately small so agents
 * key on `code`.
 */
export function classifyGoogleApiError(
	status: number,
	rawBody: string,
	retryAfterHeader?: string,
): MeetToolError {
	const trimmedBody = rawBody.slice(0, 200)
	if (status === 401) {
		return makeMeetError(
			'RECONSENT_REQUIRED',
			'Google returned 401 — the host token is invalid; the workspace must reconnect Google Meet.',
			{ provider_status: status },
		)
	}
	if (status === 403) {
		// PERMISSION_DENIED with scope hint → RECONSENT_REQUIRED, else the actor
		// is not the meeting host so surface MEETING_NOT_OWNED_BY_ACTOR.
		if (/insufficientPermissions|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(trimmedBody)) {
			return makeMeetError(
				'RECONSENT_REQUIRED',
				'Google returned 403 for a missing scope — the host must re-consent with the updated scope set.',
				{ provider_status: status },
			)
		}
		return makeMeetError(
			'MEETING_NOT_OWNED_BY_ACTOR',
			'The resolved host actor does not own this Meet resource; another workspace hosts the call.',
			{ provider_status: status },
		)
	}
	if (status === 404) {
		return makeMeetError('NOT_FOUND', 'Google Meet resource not found.', {
			provider_status: status,
		})
	}
	if (status === 429) {
		const retry = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined
		return makeMeetError('RATE_LIMITED', 'Google Meet API rate limit hit.', {
			provider_status: status,
			retry_after_ms: Number.isFinite(retry) ? retry : undefined,
		})
	}
	if (status >= 500) {
		return makeMeetError('PROVIDER_ERROR', `Google returned ${status} on a Meet API call.`, {
			provider_status: status,
		})
	}
	return makeMeetError('PROVIDER_ERROR', `Unexpected Google Meet API status ${status}.`, {
		provider_status: status,
	})
}
