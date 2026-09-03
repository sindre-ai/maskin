/**
 * Error taxonomy for the LinkedIn (Unipile-backed) provider.
 *
 * The six-class classification is the wire contract MCP tool callers reason
 * about — never re-shape without a bet, since the codes bleed into agent
 * behaviour (retry loops, human escalation, integration status flips). The
 * route handler in apps/dev/src/routes/integrations-linkedin-unipile.ts
 * classifies raw Unipile responses into one of these classes BEFORE
 * returning, and (per class) applies internal retry-with-backoff so the tool
 * layer only ever sees a terminal outcome.
 *
 * Codes mirror the parent bet spec §4:
 *
 *   CREDENTIAL_NOT_CONNECTED     Unipile 404 on account_id OR our lookup
 *                                returned null. NO retry — the actor must
 *                                reconnect via Settings > Integrations.
 *   CREDENTIAL_REVOKED           Unipile 401 OR account status
 *                                `DISCONNECTED` / `RESTRICTED` on our call.
 *                                NO retry. Also flips
 *                                `integrations.status = 'revoked'` so the
 *                                tool disappears from the actor's surface.
 *   RATE_LIMITED_UNIPILE         Unipile 429 with `X-RateLimit-*` headers.
 *                                RETRIED internally with exp backoff (base
 *                                2s, max 3 attempts, ±25% jitter, cap 30s);
 *                                only surfaces after exhaustion.
 *   LINKEDIN_ACCOUNT_RESTRICTED  Unipile body marker
 *                                (`disconnected_account_reason === 'RESTRICTED'`
 *                                or `error_code === 'account_restricted'`,
 *                                per the Unipile catalog — see
 *                                UNIPILE_RESTRICTED_MARKERS below).
 *                                NEVER retry — retrying worsens the LinkedIn
 *                                restriction. Caller pauses the actor's send
 *                                loop 24h and notifies a human.
 *   UNIPILE_UNAVAILABLE          Unipile 5xx. RETRIED internally with exp
 *                                backoff (base 3s, max 3 attempts, cap 30s);
 *                                only surfaces after exhaustion.
 *   INVALID_INPUT                Unipile 400 OR local Zod input rejection.
 *                                NO retry. Logged with body redacted.
 */
export type LinkedInErrorCode =
	| 'CREDENTIAL_NOT_CONNECTED'
	| 'CREDENTIAL_REVOKED'
	| 'RATE_LIMITED_UNIPILE'
	| 'LINKEDIN_ACCOUNT_RESTRICTED'
	| 'UNIPILE_UNAVAILABLE'
	| 'INVALID_INPUT'

export const LINKEDIN_ERROR_CODES = [
	'CREDENTIAL_NOT_CONNECTED',
	'CREDENTIAL_REVOKED',
	'RATE_LIMITED_UNIPILE',
	'LINKEDIN_ACCOUNT_RESTRICTED',
	'UNIPILE_UNAVAILABLE',
	'INVALID_INPUT',
] as const satisfies readonly LinkedInErrorCode[]

/**
 * Discriminators used to detect `LINKEDIN_ACCOUNT_RESTRICTED` in a Unipile
 * response body (spec residual 2). The Unipile Hosted Auth catalog names two
 * markers a restricted account can surface with:
 *   - `disconnected_account_reason: 'RESTRICTED'`
 *     (documented at https://developer.unipile.com/docs/handling-errors —
 *     the reason enum on the disconnected-account webhook + inline API errors)
 *   - `error_code: 'account_restricted'`
 *     (documented at https://developer.unipile.com/reference/errors — the
 *     LinkedIn-connector-specific inline error code returned on message-send
 *     when the account has been flagged by LinkedIn)
 * If Unipile revises the catalog the classifier picks up the change by
 * editing this list — no consumer code needs to change.
 */
export const UNIPILE_RESTRICTED_MARKERS = {
	disconnectedAccountReasons: ['RESTRICTED'] as const,
	errorCodes: ['account_restricted'] as const,
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
 * Retry policy per error class (spec §4). `RATE_LIMITED_UNIPILE` and
 * `UNIPILE_UNAVAILABLE` are the only classes that get retried by the route
 * handler — everything else is terminal at the first Unipile response and
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
	RATE_LIMITED_UNIPILE: { maxAttempts: 3, baseMs: 2_000, capMs: 30_000, jitter: 0.25 },
	LINKEDIN_ACCOUNT_RESTRICTED: null,
	UNIPILE_UNAVAILABLE: { maxAttempts: 3, baseMs: 3_000, capMs: 30_000, jitter: 0 },
	INVALID_INPUT: null,
}

const IS_RETRYABLE: Record<LinkedInErrorCode, boolean> = {
	CREDENTIAL_NOT_CONNECTED: false,
	CREDENTIAL_REVOKED: false,
	RATE_LIMITED_UNIPILE: true,
	LINKEDIN_ACCOUNT_RESTRICTED: false,
	UNIPILE_UNAVAILABLE: true,
	INVALID_INPUT: false,
}

const DEFAULT_HTTP_STATUS: Record<LinkedInErrorCode, number> = {
	CREDENTIAL_NOT_CONNECTED: 424,
	CREDENTIAL_REVOKED: 401,
	RATE_LIMITED_UNIPILE: 429,
	LINKEDIN_ACCOUNT_RESTRICTED: 423,
	UNIPILE_UNAVAILABLE: 502,
	INVALID_INPUT: 400,
}

/**
 * Classify a raw Unipile HTTP response (status + body) into one of the six
 * error classes. Called by the route handler for every non-2xx Unipile
 * response — the LINKEDIN_ACCOUNT_RESTRICTED marker check runs FIRST because
 * a restriction can surface on a 200 body wrapper too, and a false-positive
 * classification as UNIPILE_UNAVAILABLE would trigger the wrong retry
 * behaviour and worsen the restriction. Returns null when the response is
 * successful and carries no restriction marker.
 */
export function classifyUnipileResponse(status: number, body: unknown): LinkedInErrorCode | null {
	if (isRestrictedBody(body)) return 'LINKEDIN_ACCOUNT_RESTRICTED'
	if (status >= 200 && status < 300) return null
	if (status === 401) return 'CREDENTIAL_REVOKED'
	if (status === 404) return 'CREDENTIAL_NOT_CONNECTED'
	if (status === 429) return 'RATE_LIMITED_UNIPILE'
	if (status >= 500 && status < 600) return 'UNIPILE_UNAVAILABLE'
	if (status >= 400 && status < 500) return 'INVALID_INPUT'
	return 'UNIPILE_UNAVAILABLE'
}

function isRestrictedBody(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false
	const rec = body as Record<string, unknown>
	const reason =
		typeof rec.disconnected_account_reason === 'string'
			? rec.disconnected_account_reason.toUpperCase()
			: null
	if (reason && UNIPILE_RESTRICTED_MARKERS.disconnectedAccountReasons.includes(reason as never)) {
		return true
	}
	const errorCode = typeof rec.error_code === 'string' ? rec.error_code.toLowerCase() : null
	if (errorCode && UNIPILE_RESTRICTED_MARKERS.errorCodes.includes(errorCode as never)) {
		return true
	}
	const accountStatus =
		typeof rec.account_status === 'string' ? rec.account_status.toUpperCase() : null
	if (accountStatus === 'RESTRICTED') return true
	return false
}

/**
 * Given a Unipile account status string, decide whether the credential is
 * revoked (needs reconnect) OR still valid. Called during the pre-flight
 * check after fetching the credential row: an account that Unipile has
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
 * in the human-facing message. `client.ts` throws `UnipileUnavailableError`
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

export class RateLimitedUnipileError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super('RATE_LIMITED_UNIPILE', 'LinkedIn provider is rate-limited. Try again in ~1 minute.', {
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

export class UnipileUnavailableError extends LinkedInIntegrationError {
	constructor(cause?: unknown) {
		super(
			'UNIPILE_UNAVAILABLE',
			'LinkedIn provider is temporarily unavailable. Retry in a few minutes.',
			{ cause },
		)
	}
}

export class InvalidInputError extends LinkedInIntegrationError {
	constructor(reason: string, cause?: unknown) {
		super('INVALID_INPUT', `INVALID_INPUT: ${reason}`, { cause })
	}
}

/**
 * Task 1 spellings of the base class and code union, kept so the connect-flow
 * modules that predate the taxonomy above don't have to be touched.
 */
export type LinkedinUnipileErrorCode = LinkedInErrorCode
export const LinkedinUnipileError = LinkedInIntegrationError
export type LinkedinUnipileError = LinkedInIntegrationError
