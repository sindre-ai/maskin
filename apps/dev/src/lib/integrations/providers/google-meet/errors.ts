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
 * The wire shape below matches the addendum §5 spec verbatim: `code`,
 * `message`, `provider_status`, optional `retry_after_ms`, optional `hint`.
 * MCP tool handlers surface this as `{ error: MeetError }` inside a normal
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

export type MeetErrorCode = (typeof MEET_ERROR_CODES)[number]

export interface MeetErrorEnvelope {
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

	constructor(envelope: MeetErrorEnvelope) {
		super(envelope.message)
		this.name = 'MeetError'
		this.code = envelope.code
		this.providerStatus = envelope.provider_status
		this.retryAfterMs = envelope.retry_after_ms
		this.hint = envelope.hint
	}

	toEnvelope(): MeetErrorEnvelope {
		const out: MeetErrorEnvelope = {
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
