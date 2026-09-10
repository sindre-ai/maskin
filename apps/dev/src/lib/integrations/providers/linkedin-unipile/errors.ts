/**
 * Error taxonomy for the LinkedIn (LinkedIn-backed) provider.
 *
 * The six-class classification is the wire contract MCP tool callers reason
 * about — never re-shape without a bet, since the codes bleed into agent
 * behaviour (retry loops, human escalation, integration status flips). The
 * route handler in apps/dev/src/routes/integrations-linkedin-unipile.ts
 * classifies raw LinkedIn responses into one of these classes BEFORE
 * returning, and (per class) applies internal retry-with-backoff so the tool
 * layer only ever sees a terminal outcome.
 *
 * Codes mirror the parent bet spec §4:
 *
 *   CREDENTIAL_NOT_CONNECTED     LinkedIn 404 on account_id OR our lookup
 *                                returned null. NO retry — the actor must
 *                                reconnect via Settings > Integrations.
 *   CREDENTIAL_REVOKED           LinkedIn 401 OR account status
 *                                `DISCONNECTED` / `RESTRICTED` on our call.
 *                                NO retry. Also flips
 *                                `integrations.status = 'revoked'` so the
 *                                tool disappears from the actor's surface.
 *   RATE_LIMITED_LINKEDIN         LinkedIn 429 with `X-RateLimit-*` headers.
 *                                RETRIED internally with exp backoff (base
 *                                2s, max 3 attempts, ±25% jitter, cap 30s);
 *                                only surfaces after exhaustion.
 *   LINKEDIN_ACCOUNT_RESTRICTED  LinkedIn body marker
 *                                (`disconnected_account_reason === 'RESTRICTED'`
 *                                or `error_code === 'account_restricted'`,
 *                                per the LinkedIn catalog — see
 *                                LINKEDIN_RESTRICTED_MARKERS below).
 *                                NEVER retry — retrying worsens the LinkedIn
 *                                restriction. Caller pauses the actor's send
 *                                loop 24h and notifies a human.
 *   LINKEDIN_UNAVAILABLE          LinkedIn 5xx. RETRIED internally with exp
 *                                backoff (base 3s, max 3 attempts, cap 30s);
 *                                only surfaces after exhaustion.
 *   INVALID_INPUT                LinkedIn 400 OR local Zod input rejection.
 *                                NO retry. Logged with body redacted.
 *
 * Two connect-request-specific codes join the taxonomy from Task 7a:
 *
 *   LINKEDIN_INVITE_QUOTA_EXCEEDED  LinkedIn's weekly invitation quota for
 *                                   the connected account is spent. NEVER
 *                                   retry — burning more invitations at the
 *                                   same account worsens the restriction risk.
 *                                   Caller stops sending connection requests
 *                                   from this identity for the week and
 *                                   notifies a human.
 *   LINKEDIN_ALREADY_CONNECTED      The target member is already a first-degree
 *                                   connection OR has a pending invitation
 *                                   from this account. NEVER retry — this is
 *                                   the wire-level idempotency guarantee for
 *                                   connect-requests; the caller should treat
 *                                   it as a successful no-op.
 */
export type LinkedInErrorCode =
	| 'CREDENTIAL_NOT_CONNECTED'
	| 'CREDENTIAL_REVOKED'
	| 'RATE_LIMITED_LINKEDIN'
	| 'LINKEDIN_ACCOUNT_RESTRICTED'
	| 'LINKEDIN_POST_TOO_LONG'
	| 'LINKEDIN_UNAVAILABLE'
	| 'INVALID_INPUT'
	| 'LINKEDIN_INVITE_QUOTA_EXCEEDED'
	| 'LINKEDIN_ALREADY_CONNECTED'
	| 'PAGE_ADMIN_REVOKED'
	| 'POST_NOT_FOUND'

export const LINKEDIN_ERROR_CODES = [
	'CREDENTIAL_NOT_CONNECTED',
	'CREDENTIAL_REVOKED',
	'RATE_LIMITED_LINKEDIN',
	'LINKEDIN_ACCOUNT_RESTRICTED',
	'LINKEDIN_POST_TOO_LONG',
	'LINKEDIN_UNAVAILABLE',
	'INVALID_INPUT',
	'LINKEDIN_INVITE_QUOTA_EXCEEDED',
	'LINKEDIN_ALREADY_CONNECTED',
	'PAGE_ADMIN_REVOKED',
	'POST_NOT_FOUND',
] as const satisfies readonly LinkedInErrorCode[]

/**
 * `POST_NOT_FOUND` covers three failure modes that agents MUST treat the same
 * way (stop trying — do not retry, do not "verify" by re-issuing):
 *   1. `post_id` refers to a post that never existed.
 *   2. `post_id` refers to a post that was already deleted (LinkedIn's
 *      second-DELETE response).
 *   3. `post_id` refers to a post authored by a DIFFERENT identity — LinkedIn
 *      refuses edits and deletes on posts the calling identity did not author.
 *
 * All three surface the same wire envelope on LinkedIn's side:
 *   - status: 400 or 404
 *   - body:   { error_code: 'post_not_found', ... }  (or a `detail`/`message`
 *             containing "post not found")
 *
 * Bucketed under INVALID_INPUT at wire level (HTTP 400, no retry), distinct
 * as a named subclass so agents can branch on the code. `__delete_post`'s
 * operation layer treats `POST_NOT_FOUND` as a SUCCESSFUL NO-OP — deleting a
 * post that is already gone from LinkedIn is the intended terminal state.
 */
export const LINKEDIN_POST_NOT_FOUND_MARKERS = {
	errorCodes: ['post_not_found'] as const,
	messageFragments: ['post not found'] as const,
}

/**
 * LinkedIn's post-body hard limit is 3000 characters. LinkedIn v2's create-post
 * envelope surfaces a length rejection either with a body marker
 * (`error_code: 'post_too_long'`) or as a plain 400 whose message names the
 * limit — the classifier reads both. NEVER retry: retrying resubmits the same
 * over-limit body and gets rejected again, wasting the idempotency claim.
 * Caller shortens the text and re-issues with a NEW content hash.
 */
export const LINKEDIN_POST_TOO_LONG_MARKERS = {
	errorCodes: ['post_too_long', 'text_too_long'] as const,
	messageFragments: ['too long', 'exceeds', 'maximum length'] as const,
}

/**
 * Discriminators used to detect `LINKEDIN_ACCOUNT_RESTRICTED` in a LinkedIn
 * response body (spec residual 2). The LinkedIn Hosted Auth catalog names two
 * markers a restricted account can surface with:
 *   - `disconnected_account_reason: 'RESTRICTED'`
 *     (documented at https://developer.unipile.com/docs/handling-errors —
 *     the reason enum on the disconnected-account webhook + inline API errors)
 *   - `error_code: 'account_restricted'`
 *     (documented at https://developer.unipile.com/reference/errors — the
 *     LinkedIn-connector-specific inline error code returned on message-send
 *     when the account has been flagged by LinkedIn)
 * If LinkedIn revises the catalog the classifier picks up the change by
 * editing this list — no consumer code needs to change.
 */
export const LINKEDIN_RESTRICTED_MARKERS = {
	disconnectedAccountReasons: ['RESTRICTED'] as const,
	errorCodes: ['account_restricted'] as const,
	// v2 Hosted Auth surfaces LinkedIn account restrictions on the redirect
	// callback as `error_type=api/restricted_account`. Added when the callback
	// flipped from POST-signed body to GET redirect with query params.
	// https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth
	hostedAuthErrorTypes: ['api/restricted_account'] as const,
}

/**
 * Discriminators for the two connect-request-specific wire errors. LinkedIn
 * enforces the weekly invite quota and the already-connected check at the
 * LinkedIn API layer, and LinkedIn surfaces both as JSON error envelopes on
 * `POST /users/me/relation-requests`. As with `LINKEDIN_RESTRICTED_MARKERS`, a
 * catalog change is a single-line edit here — nothing else in the classifier
 * moves.
 *
 * Codes are lower-cased at classify time so a `error_code: 'INVITE_QUOTA_EXCEEDED'`
 * on a live payload matches the same way as the documented lower-case form.
 */
export const LINKEDIN_CONNECTION_REQUEST_MARKERS = {
	inviteQuotaExceeded: ['invite_quota_exceeded', 'invitation_limit_reached'] as const,
	alreadyConnected: ['already_connected', 'already_invited', 'pending_invitation'] as const,
}

/**
 * Discriminators for `PAGE_ADMIN_REVOKED`: LinkedIn revoked this specific
 * page's admin scope from the connected account. Structurally recoverable —
 * the ops layer deregisters the affected MCP instance and enqueues an
 * `unipile.account.updated`-style re-enumeration for the credential (spec
 * §5). Detected on a 403 to any page-scoped Unipile route AND a body
 * `error_code` in this list. Retry policy is `null`: retrying makes nothing
 * better, LinkedIn's answer is stable until the page-admin grant is
 * re-issued in LinkedIn.
 */
export const LINKEDIN_PAGE_ADMIN_REVOKED_MARKERS = {
	errorCodes: ['page_admin_revoked', 'no_admin_access'] as const,
}

/**
 * Route a LinkedIn v2 hosted-auth callback `error_type` to a wire code, or
 * `null` when the type is not an error at all (`api/already_exists` means the
 * account is already linked and the pending row should adopt the returned
 * account_id — that path is handled inline in the callback route). Unknown
 * types map to `LINKEDIN_UNAVAILABLE` so a shape drift on LinkedIn's side does
 * not silently succeed.
 */
export function classifyCallbackErrorType(errorType: string): LinkedInErrorCode | null {
	if (errorType === 'api/already_exists') return null
	if (LINKEDIN_RESTRICTED_MARKERS.hostedAuthErrorTypes.includes(errorType as never)) {
		return 'LINKEDIN_ACCOUNT_RESTRICTED'
	}
	return 'LINKEDIN_UNAVAILABLE'
}

export class LinkedInIntegrationError extends Error {
	readonly code: LinkedInErrorCode
	readonly httpStatus: number
	readonly retryable: boolean
	readonly cause?: unknown

	constructor(
		code: LinkedInErrorCode,
		message: string,
		options?: { httpStatus?: number; retryable?: boolean; cause?: unknown },
	) {
		super(message)
		this.name = 'LinkedInIntegrationError'
		this.code = code
		this.httpStatus = options?.httpStatus ?? DEFAULT_HTTP_STATUS[code]
		this.retryable = options?.retryable ?? IS_RETRYABLE[code]
		this.cause = options?.cause
	}
}

export function isLinkedInIntegrationError(err: unknown): err is LinkedInIntegrationError {
	return err instanceof LinkedInIntegrationError
}

/**
 * Retry policy per error class (spec §4). `RATE_LIMITED_LINKEDIN` and
 * `LINKEDIN_UNAVAILABLE` are the only classes that get retried by the route
 * handler — everything else is terminal at the first LinkedIn response and
 * bubbles straight out. The values match spec §4:
 *   - 429: base 2s, max 3 attempts, jitter ±25%, cap 30s
 *   - 5xx: base 3s, max 3 attempts, cap 30s (no jitter — the server-side
 *          outage is uncorrelated across our replicas, so jitter buys nothing)
 */
export type RetryPolicy = {
	maxAttempts: number
	baseMs: number
	capMs: number
	jitter: number
}

export const RETRY_POLICY_BY_CODE: Record<LinkedInErrorCode, RetryPolicy | null> = {
	CREDENTIAL_NOT_CONNECTED: null,
	CREDENTIAL_REVOKED: null,
	RATE_LIMITED_LINKEDIN: { maxAttempts: 3, baseMs: 2_000, capMs: 30_000, jitter: 0.25 },
	LINKEDIN_ACCOUNT_RESTRICTED: null,
	LINKEDIN_POST_TOO_LONG: null,
	LINKEDIN_UNAVAILABLE: { maxAttempts: 3, baseMs: 3_000, capMs: 30_000, jitter: 0 },
	INVALID_INPUT: null,
	// Both connect-request errors are terminal at the first response:
	// retrying quota-exceeded burns more quota against the same account, and
	// retrying already-connected accomplishes nothing (LinkedIn has already
	// answered "no" to that specific invite).
	LINKEDIN_INVITE_QUOTA_EXCEEDED: null,
	LINKEDIN_ALREADY_CONNECTED: null,
	// Page-admin revoke is terminal for the current call: LinkedIn removed
	// the page's admin scope from this account. Retrying gets the same 403
	// until the page admin re-invites us in LinkedIn; the ops-layer side
	// effect (deregister-and-re-enumerate) is what makes the loop learn of
	// the change.
	PAGE_ADMIN_REVOKED: null,
	// POST_NOT_FOUND is terminal: retrying an edit/delete on a post LinkedIn
	// says does not exist just gets the same POST_NOT_FOUND back. Delete
	// operations treat this as a successful no-op at the operations layer.
	POST_NOT_FOUND: null,
}

const IS_RETRYABLE: Record<LinkedInErrorCode, boolean> = {
	CREDENTIAL_NOT_CONNECTED: false,
	CREDENTIAL_REVOKED: false,
	RATE_LIMITED_LINKEDIN: true,
	LINKEDIN_ACCOUNT_RESTRICTED: false,
	LINKEDIN_POST_TOO_LONG: false,
	LINKEDIN_UNAVAILABLE: true,
	INVALID_INPUT: false,
	LINKEDIN_INVITE_QUOTA_EXCEEDED: false,
	LINKEDIN_ALREADY_CONNECTED: false,
	PAGE_ADMIN_REVOKED: false,
	POST_NOT_FOUND: false,
}

const DEFAULT_HTTP_STATUS: Record<LinkedInErrorCode, number> = {
	CREDENTIAL_NOT_CONNECTED: 424,
	CREDENTIAL_REVOKED: 401,
	RATE_LIMITED_LINKEDIN: 429,
	LINKEDIN_ACCOUNT_RESTRICTED: 423,
	LINKEDIN_POST_TOO_LONG: 400,
	LINKEDIN_UNAVAILABLE: 502,
	INVALID_INPUT: 400,
	// 403 for quota: LinkedIn's answer is "you may not perform this action
	// right now" — a permissions-shaped no rather than a validation-shaped
	// one. 409 for already-connected: state conflict, the classic HTTP fit.
	LINKEDIN_INVITE_QUOTA_EXCEEDED: 403,
	LINKEDIN_ALREADY_CONNECTED: 409,
	// 403: LinkedIn's own status for the revoked-page-admin envelope.
	// Surfacing the same class through the same status keeps the wire
	// self-describing.
	PAGE_ADMIN_REVOKED: 403,
	// Bucketed under INVALID_INPUT at wire level (spec §5): the caller made a
	// request LinkedIn cannot honour — same 400 shape agents already handle
	// for other input-shaped nos. Distinct code so a `__delete_post` op can
	// swallow it as a no-op without swallowing every other INVALID_INPUT.
	POST_NOT_FOUND: 400,
}

/**
 * Classify a raw LinkedIn HTTP response (status + body) into one of the six
 * error classes. Called by the route handler for every non-2xx LinkedIn
 * response — the LINKEDIN_ACCOUNT_RESTRICTED marker check runs FIRST because
 * a restriction can surface on a 200 body wrapper too, and a false-positive
 * classification as LINKEDIN_UNAVAILABLE would trigger the wrong retry
 * behaviour and worsen the restriction. Returns null when the response is
 * successful and carries no restriction marker.
 *
 * The connect-request markers (`LINKEDIN_INVITE_QUOTA_EXCEEDED`,
 * `LINKEDIN_ALREADY_CONNECTED`) run BEFORE the generic 4xx → INVALID_INPUT
 * fallback so that a 400/409 with a documented error_code lands in the right
 * class instead of collapsing into a generic "bad request" that would look
 * like a schema bug to the caller.
 */
export function classifyLinkedInResponse(status: number, body: unknown): LinkedInErrorCode | null {
	if (isRestrictedBody(body)) return 'LINKEDIN_ACCOUNT_RESTRICTED'
	if (isInviteQuotaExceededBody(body)) return 'LINKEDIN_INVITE_QUOTA_EXCEEDED'
	if (isAlreadyConnectedBody(body)) return 'LINKEDIN_ALREADY_CONNECTED'
	if (isPostTooLongBody(body)) return 'LINKEDIN_POST_TOO_LONG'
	// PAGE_ADMIN_REVOKED must run BEFORE the generic 403 → INVALID_INPUT
	// fallback: 403 alone would land in the wrong class (retry policy null
	// either way, but the ops-layer side effect for
	// PAGE_ADMIN_REVOKED — deregister the instance + enqueue re-enumeration —
	// only fires when the classifier picks the specific class).
	if (status === 403 && isPageAdminRevokedBody(body)) return 'PAGE_ADMIN_REVOKED'
	// POST_NOT_FOUND detection runs BEFORE the generic 4xx → INVALID_INPUT
	// fallback so an edit/delete against a missing / already-deleted /
	// non-authored post lands in its own class instead of collapsing into a
	// generic "bad request" — `__delete_post` needs to distinguish the two
	// to treat POST_NOT_FOUND as a successful no-op. Only fires on the 400/404
	// statuses LinkedIn uses for this (never on a 5xx or an unrelated 4xx).
	if ((status === 400 || status === 404) && isPostNotFoundBody(body)) return 'POST_NOT_FOUND'
	if (status >= 200 && status < 300) return null
	if (status === 401) return 'CREDENTIAL_REVOKED'
	if (status === 404) return 'CREDENTIAL_NOT_CONNECTED'
	if (status === 429) return 'RATE_LIMITED_LINKEDIN'
	// 501 `api/not_implemented` is NOT an outage — it is LinkedIn telling us we
	// called a route it does not implement for this provider ("Use Start a Chat
	// in the given inbox endpoint", "Use List inbox Chats endpoint"). Left in
	// the 5xx bucket it becomes a retryable LINKEDIN_UNAVAILABLE, so the route
	// burns three backoff attempts on a request that can never succeed and then
	// reports a LinkedIn outage for what is our own wrong URL. INVALID_INPUT is
	// the existing non-retryable class that says "the request was wrong" — the
	// taxonomy is a wire contract (see the header) and does not grow for this.
	if (status === 501 || isNotImplementedBody(body)) return 'INVALID_INPUT'
	if (status >= 500 && status < 600) return 'LINKEDIN_UNAVAILABLE'
	if (status >= 400 && status < 500) return 'INVALID_INPUT'
	return 'LINKEDIN_UNAVAILABLE'
}

/**
 * LinkedIn answers a route it does not implement for the calling provider with
 * `{ status: 501, type: 'api/not_implemented', detail: 'Use … endpoint for this
 * provider.' }`. The status alone is enough in practice, but the type is read
 * too because the same envelope has been observed on a 200-shaped error body,
 * and a wrong-route response that reads as an outage sends the caller chasing
 * LinkedIn's status page instead of the URL.
 */
function isNotImplementedBody(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false
	const rec = body as Record<string, unknown>
	const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : null
	const errorType = typeof rec.error_type === 'string' ? rec.error_type.toLowerCase() : null
	return type === 'api/not_implemented' || errorType === 'api/not_implemented'
}

/**
 * Detect the POST_NOT_FOUND envelope on an edit/delete response. Fires on
 * `body.error_code === 'post_not_found'` (case-insensitive) OR when
 * `message` / `detail` contain the phrase "post not found". Detection intentionally
 * matches on the phrase regardless of status — the classifier's caller gates
 * on 400/404 so this cannot fire on an unrelated 500.
 */
function isPostNotFoundBody(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false
	const rec = body as Record<string, unknown>
	const errorCode = typeof rec.error_code === 'string' ? rec.error_code.toLowerCase() : null
	if (errorCode && LINKEDIN_POST_NOT_FOUND_MARKERS.errorCodes.includes(errorCode as never)) {
		return true
	}
	const message = typeof rec.message === 'string' ? rec.message.toLowerCase() : ''
	const detail = typeof rec.detail === 'string' ? rec.detail.toLowerCase() : ''
	const haystack = `${message} ${detail}`
	return LINKEDIN_POST_NOT_FOUND_MARKERS.messageFragments.some((frag) => haystack.includes(frag))
}

function isPostTooLongBody(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false
	const rec = body as Record<string, unknown>
	const errorCode = typeof rec.error_code === 'string' ? rec.error_code.toLowerCase() : null
	if (errorCode && LINKEDIN_POST_TOO_LONG_MARKERS.errorCodes.includes(errorCode as never)) {
		return true
	}
	const message = typeof rec.message === 'string' ? rec.message.toLowerCase() : ''
	const detail = typeof rec.detail === 'string' ? rec.detail.toLowerCase() : ''
	const haystack = `${message} ${detail}`
	if (!haystack.includes('post') && !haystack.includes('text')) return false
	return LINKEDIN_POST_TOO_LONG_MARKERS.messageFragments.some((frag) => haystack.includes(frag))
}

function isRestrictedBody(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false
	const rec = body as Record<string, unknown>
	const reason =
		typeof rec.disconnected_account_reason === 'string'
			? rec.disconnected_account_reason.toUpperCase()
			: null
	if (reason && LINKEDIN_RESTRICTED_MARKERS.disconnectedAccountReasons.includes(reason as never)) {
		return true
	}
	const errorCode = typeof rec.error_code === 'string' ? rec.error_code.toLowerCase() : null
	if (errorCode && LINKEDIN_RESTRICTED_MARKERS.errorCodes.includes(errorCode as never)) {
		return true
	}
	const accountStatus =
		typeof rec.account_status === 'string' ? rec.account_status.toUpperCase() : null
	if (accountStatus === 'RESTRICTED') return true
	return false
}

function readErrorCode(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null
	const rec = body as Record<string, unknown>
	return typeof rec.error_code === 'string' ? rec.error_code.toLowerCase() : null
}

function isInviteQuotaExceededBody(body: unknown): boolean {
	const code = readErrorCode(body)
	if (!code) return false
	return LINKEDIN_CONNECTION_REQUEST_MARKERS.inviteQuotaExceeded.includes(code as never)
}

function isAlreadyConnectedBody(body: unknown): boolean {
	const code = readErrorCode(body)
	if (!code) return false
	return LINKEDIN_CONNECTION_REQUEST_MARKERS.alreadyConnected.includes(code as never)
}

/**
 * Detect the `PAGE_ADMIN_REVOKED` body shape: LinkedIn returns 403 with
 * `error_code` in `LINKEDIN_PAGE_ADMIN_REVOKED_MARKERS.errorCodes` when the
 * connected account no longer has admin rights on a page. Exported so the
 * webhook handler can share the discriminator with the runtime classifier —
 * a body-marker change (LinkedIn adding a new error_code alias) is a
 * one-line edit in one place.
 */
export function isPageAdminRevokedBody(body: unknown): boolean {
	const code = readErrorCode(body)
	if (!code) return false
	return LINKEDIN_PAGE_ADMIN_REVOKED_MARKERS.errorCodes.includes(code as never)
}

/**
 * Given a LinkedIn account status string, decide whether the credential is
 * revoked (needs reconnect) OR still valid. Called during the pre-flight
 * check after fetching the credential row: an account that LinkedIn has
 * disconnected server-side should surface as `CREDENTIAL_REVOKED` before we
 * spend a network round-trip on the actual send.
 */
export function isAccountStatusRevoked(accountStatus: string | null | undefined): boolean {
	if (!accountStatus) return false
	const s = accountStatus.toUpperCase()
	return s === 'DISCONNECTED' || s === 'RESTRICTED'
}

/**
 * Sleep helper used by the backoff walker in the route handler.
 * Exported so tests can spy on it without introducing a fake-timer setup for
 * every case.
 */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Compute the backoff wait for the Nth attempt (0-indexed) of a given policy.
 * Exponential with optional jitter, capped at `policy.capMs`.
 */
export function computeBackoffMs(policy: RetryPolicy, attemptIndex: number): number {
	const raw = Math.min(policy.capMs, policy.baseMs * 2 ** attemptIndex)
	if (policy.jitter <= 0) return raw
	const jitterRange = raw * policy.jitter
	const offset = (Math.random() * 2 - 1) * jitterRange
	return Math.max(0, Math.min(policy.capMs, raw + offset))
}

/**
 * Named subclasses, one per code.
 *
 * These are the Task 1 (connect-flow) spelling of the same six classes: the
 * taxonomy above is the wire contract, and these are constructors that fill
 * in the human-facing message. `client.ts` throws `LinkedInUnavailableError`
 * on a transport failure, so the connect flow never has to know the message
 * text or the retry policy — both live here.
 *
 * A subclass adds no behaviour beyond a default message: every one of them is
 * a `LinkedInIntegrationError`, so `isLinkedInIntegrationError`,
 * `RETRY_POLICY_BY_CODE` and the route's `handleTerminalError` treat them
 * identically to a directly-constructed error with the same code. Prefer the
 * subclass when the message is the standard one, and the base class when the
 * route has a more specific message to give.
 */
export class CredentialNotConnectedError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'CREDENTIAL_NOT_CONNECTED',
			'LinkedIn is not connected for this actor. Ask the workspace member to reconnect at Settings > Integrations.',
			{ cause },
		)
	}
}

export class CredentialRevokedError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'CREDENTIAL_REVOKED',
			'The LinkedIn connection has been revoked. Reconnect at Settings > Integrations.',
			{ cause },
		)
	}
}

export class RateLimitedLinkedInError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super('RATE_LIMITED_LINKEDIN', 'LinkedIn provider is rate-limited. Try again in ~1 minute.', {
			cause,
		})
	}
}

export class LinkedinAccountRestrictedError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'LINKEDIN_ACCOUNT_RESTRICTED',
			'LinkedIn has restricted this account. Sending will be blocked until LinkedIn lifts the restriction (typically 24-72h).',
			{ cause },
		)
	}
}

export class LinkedInUnavailableError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'LINKEDIN_UNAVAILABLE',
			'LinkedIn provider is temporarily unavailable. Retry in a few minutes.',
			{ cause },
		)
	}
}

export class LinkedinPostTooLongError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'LINKEDIN_POST_TOO_LONG',
			'LinkedIn post exceeds the 3000-character limit. Shorten the text before re-issuing.',
			{ cause },
		)
	}
}

export class InvalidInputError extends LinkedInIntegrationError {
	constructor(reason: string, cause?: unknown) {
		super('INVALID_INPUT', `INVALID_INPUT: ${reason}`, { cause })
	}
}

export class LinkedinInviteQuotaExceededError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'LINKEDIN_INVITE_QUOTA_EXCEEDED',
			"LinkedIn's weekly invitation quota for this account is exhausted. Stop sending connection requests from this identity until the quota resets.",
			{ cause },
		)
	}
}

export class LinkedinAlreadyConnectedError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'LINKEDIN_ALREADY_CONNECTED',
			'This member is already a first-degree connection or has a pending invitation from this account. Treat as a successful no-op.',
			{ cause },
		)
	}
}

/**
 * Named subclass for `PAGE_ADMIN_REVOKED`. The current call is terminal
 * (retry policy is null); the ops layer additionally deregisters the
 * affected LinkedIn MCP instance and enqueues an
 * `unipile.account.updated`-style re-enumeration for the credential so the
 * loop sees the change on the NEXT call rather than continuing to attach a
 * tool that will 403 again.
 */
export class PageAdminRevokedError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'PAGE_ADMIN_REVOKED',
			"LinkedIn has revoked this account's admin access to the target page. The page has been unregistered; ask a page admin to re-invite the account in LinkedIn to restore it.",
			{ cause },
		)
	}
}

/**
 * Post-not-found / already-deleted / not-authored-by-this-identity — three
 * failure modes LinkedIn surfaces the same way and that agents MUST treat the
 * same way (stop trying). The message is deliberately one sentence covering
 * all three, because we cannot distinguish them from LinkedIn's response and
 * must not guess at which one it was for the human reading a log line.
 *
 * Wire code is `POST_NOT_FOUND`, but the operation layer for `__delete_post`
 * treats this error as a SUCCESSFUL NO-OP (spec §5) — the post is gone, which
 * is the intended terminal state. `__edit_post` re-raises unchanged.
 */
export class PostNotFoundError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super('POST_NOT_FOUND', 'Post not found, already deleted, or not authored by this identity.', {
			cause,
		})
	}
}

/**
 * Task 1 spellings of the base class and code union, kept so the connect-flow
 * modules that predate the taxonomy above don't have to be touched.
 */
export type LinkedinErrorCode = LinkedInErrorCode
export const LinkedinError = LinkedInIntegrationError
export type LinkedinError = LinkedInIntegrationError
