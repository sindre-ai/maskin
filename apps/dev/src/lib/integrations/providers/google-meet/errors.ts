/**
 * Normalized error envelope shared by every google-meet MCP tool.
 *
 * Callers get a machine-actionable `code` plus the raw provider status;
 * Google's raw JSON never bleeds through.
 *
 * This module is the union of two slices that landed in parallel on the bet
 * (read-path Task 3 + write-path Task 4). The read-path tools carry the
 * envelope on `MeetToolError.envelope` (already wrapped: `{ error: {...} }`);
 * the write-path tools build a flat payload via `MeetError.toEnvelope()` and
 * the tool wrapper wraps it as `{ error: {...} }` at emit time. Both emit the
 * SAME wire shape — a single `{ error: { code, message, provider_status,
 * retry_after_ms?, hint? } }` object — which is what agents and consumer
 * triggers key on. The two classes are kept side by side because each slice's
 * call sites and tests depend on its own accessor shape; unify them only under
 * a bet that also migrates those call sites.
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

/**
 * Error taxonomy for the Google Meet MCP write path (google_meet__create_space
 * + google_meet__create_meet_backed_event). Same normalised envelope shape
 * Task 3 uses on the read path — never re-shape without a bet: the codes
 * bleed into agent behaviour (retry vs re-consent vs surface-to-human) and
 * into consumer triggers that filter on them.
 *
 * Codes (from carried-forward tech spec 03b10f81 §4.4 + addendum 27a2f10e §5,
 * pinned to the write-path acceptance criteria on task 824f1a6a):
 *
 *   RECONSENT_REQUIRED          Token lacks `meetings.space.created`. NO
 *                               retry — the actor must reconnect Google Meet
 *                               to add the scope. Also raised on generic 401
 *                               once TokenManager has flipped the row to
 *                               `revoked` (invalid_grant on refresh).
 *   PROVIDER_ERROR              Google 5xx after a 5-retry exponential
 *                               backoff. Terminal to the caller.
 *   NOT_FOUND                   Google 404 — for create_meet_backed_event
 *                               this typically means the calendar id is
 *                               invalid. NO retry.
 *   RATE_LIMITED                Google 429 after the backoff cap. Caller
 *                               waits, then retries; provider_status carries
 *                               the retry-after hint if Google sent one.
 *   MEET_REQUIRES_WORKSPACE     Free consumer Google accounts cannot
 *                               provision Meet spaces via the API. Detected
 *                               either at tool-call time (calendar tier
 *                               check) or in Google's response body (specific
 *                               error strings). NO retry — the actor must
 *                               connect a Workspace-tier Google account.
 *   MEETING_NOT_OWNED_BY_ACTOR  Reserved — not raised by the write path
 *                               today (create tools own what they create),
 *                               but named here so Task 3's read path and this
 *                               file share one closed enum.
 *
 * The flat payload below matches the addendum §5 spec verbatim: `code`,
 * `message`, `provider_status`, optional `retry_after_ms`, optional `hint`.
 * MCP tool handlers surface this as `{ error: <payload> }` inside a normal
 * JSON tool result — NOT as an MCP transport error — so an agent that reads
 * the result gets the code and hint verbatim.
 */

export const MEET_ERROR_CODES = [
	'RECONSENT_REQUIRED',
	'PROVIDER_ERROR',
	'NOT_FOUND',
	'RATE_LIMITED',
	'MEET_REQUIRES_WORKSPACE',
	'MEETING_NOT_OWNED_BY_ACTOR',
] as const

/**
 * The flat payload the write path emits inside a tool result's `error` key.
 * The read path's `MeetErrorEnvelope` wraps the same fields under `.error` at
 * construction time; this type is the unwrapped form the write path uses and
 * the tool wrapper re-wraps. Kept separate from `MeetErrorEnvelope` so the two
 * slices' construction styles stay explicit.
 */
export interface MeetErrorPayload {
	code: MeetErrorCode
	message: string
	provider_status: number
	retry_after_ms?: number
	hint?: string
}

export class MeetError extends Error {
	readonly code: MeetErrorCode
	readonly providerStatus: number
	readonly retryAfterMs?: number
	readonly hint?: string

	constructor(envelope: MeetErrorPayload) {
		super(envelope.message)
		this.name = 'MeetError'
		this.code = envelope.code
		this.providerStatus = envelope.provider_status
		this.retryAfterMs = envelope.retry_after_ms
		this.hint = envelope.hint
	}

	toEnvelope(): MeetErrorPayload {
		const out: MeetErrorPayload = {
			code: this.code,
			message: this.message,
			provider_status: this.providerStatus,
		}
		if (this.retryAfterMs !== undefined) out.retry_after_ms = this.retryAfterMs
		if (this.hint !== undefined) out.hint = this.hint
		return out
	}
}

export function isMeetError(err: unknown): err is MeetError {
	return err instanceof MeetError
}

/**
 * Google surfaces missing-scope conditions two ways depending on the endpoint:
 * a 403 with `status: 'PERMISSION_DENIED'` + a body that names the scope, OR
 * a 401 when the access token no longer covers the required scope after a
 * consent revoke. TokenManager's revoke path already flips the integration
 * row on `invalid_grant`; here we only classify the response the tool got.
 *
 * Match on the literal scope URI so a future scope-name change on the Meet
 * side surfaces as PROVIDER_ERROR rather than a silent miss — safer than a
 * broad "insufficient" substring test.
 */
const RECONSENT_SCOPE_MARKERS = [
	'meetings.space.created',
	'https://www.googleapis.com/auth/meetings.space.created',
	'insufficient authentication scopes',
	'insufficient_scope',
] as const

/**
 * Meet API rejects free consumer accounts with error bodies that name the
 * account tier explicitly. Keeping the marker set literal (not a substring
 * match on "workspace") so a Workspace-tier account whose response happens
 * to include the word "workspace" doesn't get mis-classified.
 */
const MEET_REQUIRES_WORKSPACE_MARKERS = [
	'requires a google workspace',
	'requires a workspace account',
	'meet is only available',
	'google workspace subscription',
] as const

/**
 * Map a raw Google API response (already read into a JSON body when possible)
 * into a MeetError. `bodyText` is the raw response text — kept so the classifier
 * can pattern-match on Google's specific error strings without depending on
 * the JSON parse succeeding (Google occasionally returns HTML for 5xx).
 */
export function classifyGoogleError(params: {
	status: number
	bodyText: string
	body?: unknown
	retryAfterHeader?: string | null
}): MeetError {
	const { status, bodyText, body, retryAfterHeader } = params
	const bodyLower = bodyText.toLowerCase()
	const providerMessage = extractProviderMessage(body) ?? truncate(bodyText, 500)

	if (status === 401) {
		return new MeetError({
			code: 'RECONSENT_REQUIRED',
			message: 'Google rejected the access token. The connected Meet account must reconnect.',
			provider_status: status,
			hint: 'Ask the actor to reconnect Google Meet in Settings → Integrations.',
		})
	}

	if (status === 403) {
		if (RECONSENT_SCOPE_MARKERS.some((m) => bodyLower.includes(m))) {
			return new MeetError({
				code: 'RECONSENT_REQUIRED',
				message:
					'Google Meet scope `meetings.space.created` is not granted on this actor\'s token.',
				provider_status: status,
				hint: 'Ask the actor to reconnect Google Meet and grant the Create-meetings scope.',
			})
		}
		if (MEET_REQUIRES_WORKSPACE_MARKERS.some((m) => bodyLower.includes(m))) {
			return new MeetError({
				code: 'MEET_REQUIRES_WORKSPACE',
				message:
					'Google Meet spaces cannot be provisioned on this account — a Google Workspace subscription is required.',
				provider_status: status,
				hint: 'The connected account is a free consumer Google account; use a Google Workspace account.',
			})
		}
		return new MeetError({
			code: 'PROVIDER_ERROR',
			message: providerMessage || 'Google returned 403 for the Meet API call.',
			provider_status: status,
		})
	}

	if (status === 404) {
		return new MeetError({
			code: 'NOT_FOUND',
			message: providerMessage || 'Google returned 404. If creating an event, verify the calendar id.',
			provider_status: status,
		})
	}

	if (status === 429) {
		return new MeetError({
			code: 'RATE_LIMITED',
			message: 'Google rate-limited the Meet API call after the retry budget was exhausted.',
			provider_status: status,
			retry_after_ms: parseRetryAfter(retryAfterHeader),
		})
	}

	if (status >= 500) {
		return new MeetError({
			code: 'PROVIDER_ERROR',
			message: providerMessage || `Google returned ${status} after the 5-retry backoff.`,
			provider_status: status,
		})
	}

	// Any 4xx we didn't classify above (400 validation, 409 conflict, etc.) —
	// treat as terminal PROVIDER_ERROR carrying the provider's message.
	return new MeetError({
		code: 'PROVIDER_ERROR',
		message: providerMessage || `Google returned ${status}.`,
		provider_status: status,
	})
}

function extractProviderMessage(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null
	const b = body as { error?: { message?: string; status?: string } }
	if (b.error && typeof b.error.message === 'string') return b.error.message
	return null
}

/**
 * `Retry-After` can be either delta-seconds or an HTTP-date. Google's Meet API
 * uses seconds today; we support both because the header format is not
 * versioned and switching once shipped is a common integration-side surprise.
 */
function parseRetryAfter(header?: string | null): number | undefined {
	if (!header) return undefined
	const asNumber = Number(header)
	if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000)
	const asDate = Date.parse(header)
	if (Number.isFinite(asDate)) {
		const delta = asDate - Date.now()
		return delta > 0 ? delta : 0
	}
	return undefined
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max)}…`
}
