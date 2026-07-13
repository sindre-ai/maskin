import { logger } from '../../../logger'
import { fetchInstallationOwnerLogin } from './auth'

export type GithubFailureTag =
	| 'missing-token'
	| 'anon-rate-limit'
	| '403-permission'
	| '401-unauth'
	| 'schema-validation'
	| 'mergeable-blocked'
	| 'token-expired-mid-session'

// ~50 min — the safety threshold from the runbook / knowledge article (~1h TTL).
export const TOKEN_EXPIRY_THRESHOLD_MS = 50 * 60 * 1000

export interface TokenContext {
	/** ms since epoch when the installation access token was minted. */
	mintedAt: number
	/** installation ID the token was minted against. */
	installationId: string
}

export interface FailureSignal {
	/** HTTP status code returned by the GitHub API (if the failure was an HTTP response). */
	status?: number
	/** Response body as a string (or the error message when the failure was a thrown error). */
	body?: string
	/** Response headers, lowercase-keyed. */
	headers?: Record<string, string | undefined>
	/** Whether an Authorization header was attached to the outbound request. */
	hadToken?: boolean
	/** Token mint metadata — required to distinguish token-expired-mid-session from a generic 401. */
	tokenContext?: TokenContext
	/** Override the "current time" for tests. Defaults to Date.now(). */
	now?: number
}

export interface FailureTag {
	cause: GithubFailureTag
	/**
	 * Secondary cause when a failure carries more than one classifiable signal
	 * (e.g. a 401 that also matches rate-limit body). Present only for
	 * genuinely ambiguous multi-cause failures.
	 */
	secondary_cause?: GithubFailureTag
	/** Human-readable reason string, useful for logs and downstream consumers. */
	reason: string
}

// Body-shape signals. All matched against small (≤200 char) body slices from
// well-formed GitHub API responses — no unbounded backtracking.
const RATE_LIMIT_BODY_RE = /API rate limit exceeded/i
// mergeable_state key with a blocked value, mergeable=false, or human-readable
// mergeability messages (required check pending, review missing, branch behind).
const MERGEABLE_BLOCKED_BODY_RE =
	/mergeable_state["'\s:]+(dirty|blocked|behind|unstable)|mergeable["'\s:]+false|required status check|required approving review|Base branch was modified|not mergeable/i
// Zod-shaped errors, GitHub validation_failed, or plain schema-mismatch messages.
const SCHEMA_VALIDATION_BODY_RE =
	/Validation Failed|expected \w+, received \w+|\bschema\b|\binvalid_request\b|Invalid input/i
// GitHub tokens ever end up in error bodies (e.g. echoed inside a debug
// message). Strip anything that looks like one before we log the reason.
const GITHUB_TOKEN_LIKE_RE = /gh[oprsu]_[A-Za-z0-9_]{16,}/g

function redactTokens(input: string): string {
	return input.replace(GITHUB_TOKEN_LIKE_RE, '[REDACTED_TOKEN]')
}

function bodySlice(body: string): string {
	return redactTokens(body).slice(0, 200)
}

function parseRateLimitCeiling(headers?: Record<string, string | undefined>): number | undefined {
	if (!headers) return undefined
	const raw = headers['x-ratelimit-limit'] ?? headers['X-RateLimit-Limit']
	if (raw == null) return undefined
	const n = Number(raw)
	return Number.isFinite(n) ? n : undefined
}

function detectMissingToken(sig: FailureSignal): boolean {
	if (sig.hadToken === false) return true
	// Fallback signal: unauthenticated hit on GitHub's per-IP 60/hr bucket
	// with no Authorization ever attached. The rate-limit ceiling is the
	// tell — 60 is the anonymous bucket, 5000+ is authenticated.
	const ceiling = parseRateLimitCeiling(sig.headers)
	if (ceiling != null && ceiling <= 60 && sig.hadToken !== true) {
		if (sig.body && /requires authentication/i.test(sig.body)) return true
	}
	return false
}

function detectAnonRateLimit(sig: FailureSignal): boolean {
	if (!sig.body || !RATE_LIMIT_BODY_RE.test(sig.body)) return false
	// A 401 with hadToken=true means the token WAS attached but rejected —
	// that's 401-unauth / token-expired-mid-session, not "went anonymous".
	// Anon-rate-limit typically manifests as 403 or 429 with the 60/hr bucket.
	if (sig.status === 401 && sig.hadToken === true) return false
	const ceiling = parseRateLimitCeiling(sig.headers)
	// Anonymous ceiling is 60/hr; authenticated is 5000+/hr.
	if (ceiling != null) return ceiling <= 60
	// No ceiling header: only classify as anon when the caller confirmed no
	// token was sent, otherwise fall through to a different tag.
	return sig.hadToken === false
}

function detectSchemaValidation(sig: FailureSignal): boolean {
	if (sig.status === 422) return true
	return !!sig.body && SCHEMA_VALIDATION_BODY_RE.test(sig.body)
}

function detectMergeableBlocked(sig: FailureSignal): boolean {
	if (!sig.body) return false
	if (!MERGEABLE_BLOCKED_BODY_RE.test(sig.body)) return false
	// 405/409 on the merge endpoint, or any status where the body explicitly
	// carries a mergeability reason, both count.
	if (sig.status === 405 || sig.status === 409) return true
	return /mergeable_state|mergeable/.test(sig.body)
}

/**
 * Was the installation ID still resolvable at call time? A live probe against
 * GitHub — used only when the failure is 401 and we can't already tell from
 * mint-age alone. Returns `true` if the install still resolves, `false` if
 * it 404s (App reinstalled mid-session — the classic churn case), or
 * `undefined` if the probe itself errored (network) and we can't tell.
 */
export async function probeInstallationResolves(
	installationId: string,
): Promise<boolean | undefined> {
	try {
		await fetchInstallationOwnerLogin(installationId)
		return true
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (/\b404\b/.test(msg)) return false
		return undefined
	}
}

/**
 * Classify a GitHub failure synchronously. Does NOT probe the network — if the
 * caller wants installation-ID churn detection, they must run
 * `probeInstallationResolves` first and pass the outcome via the async wrapper
 * below.
 */
export function classifyGithubFailure(
	sig: FailureSignal,
	installationResolvesNow?: boolean,
): FailureTag {
	const now = sig.now ?? Date.now()
	const bodyOrMsg = sig.body ?? ''

	// Priority-ordered detection.
	const isMissingToken = detectMissingToken(sig)
	const isAnonRateLimit = detectAnonRateLimit(sig)
	const isSchema = detectSchemaValidation(sig)
	const isMergeableBlocked = detectMergeableBlocked(sig)

	if (isMissingToken) {
		return {
			cause: 'missing-token',
			reason: 'no Authorization header attached to the request',
		}
	}

	if (isAnonRateLimit) {
		return {
			cause: 'anon-rate-limit',
			reason: 'GitHub returned anonymous (60/hr per-IP) rate-limit exceeded',
		}
	}

	if (isSchema) {
		return {
			cause: 'schema-validation',
			reason: 'input failed the tool schema — client-side bug, not auth',
		}
	}

	if (isMergeableBlocked) {
		return {
			cause: 'mergeable-blocked',
			reason: 'GitHub reported the PR is not mergeable (CI, review, or branch state)',
		}
	}

	if (sig.status === 401) {
		// Mid-session 401 disambiguation.
		let expired = false
		let expiryReason = ''
		if (installationResolvesNow === false) {
			expired = true
			expiryReason = 'installation ID no longer resolves — App reinstalled mid-session'
		} else if (sig.tokenContext) {
			const age = now - sig.tokenContext.mintedAt
			if (age >= TOKEN_EXPIRY_THRESHOLD_MS) {
				expired = true
				expiryReason = `token mint-age ${Math.round(age / 1000)}s exceeds threshold ${TOKEN_EXPIRY_THRESHOLD_MS / 1000}s`
			}
		}
		// Ambiguity capture — if the body ALSO matches another rule, record it
		// as secondary_cause so the tag still explains the primary decision but
		// downstream consumers see both signals.
		const secondary = detectSecondarySignal(sig)
		if (expired) {
			return {
				cause: 'token-expired-mid-session',
				secondary_cause: secondary,
				reason: expiryReason,
			}
		}
		return {
			cause: '401-unauth',
			secondary_cause: secondary,
			reason: bodyOrMsg
				? `token rejected by GitHub: ${bodySlice(bodyOrMsg)}`
				: 'token rejected by GitHub',
		}
	}

	if (sig.status === 403) {
		// A 403 with a rate-limit body is authenticated rate-limit (not anon),
		// so we tag 403-permission and don't set secondary — anon is a different
		// bucket that requires ceiling=60.
		return {
			cause: '403-permission',
			reason: bodyOrMsg ? `permission denied: ${bodySlice(bodyOrMsg)}` : 'permission denied',
		}
	}

	// Ambiguous multi-cause fallback: no exclusive rule matched. If the body
	// carries any single signal, use it as primary rather than leaving the
	// failure untagged. Otherwise default to 401-unauth (safer than silent).
	if (bodyOrMsg && /requires authentication/i.test(bodyOrMsg)) {
		return { cause: '401-unauth', reason: 'requires authentication (no status code)' }
	}
	return {
		cause: '401-unauth',
		reason: `unclassified failure — status=${sig.status ?? 'n/a'}, body=${bodySlice(bodyOrMsg)}`,
	}
}

/**
 * When the primary tag is 401-unauth or token-expired-mid-session, the body
 * may also carry a rate-limit signal — record it as secondary so the DoD's
 * "Ambiguous multi-cause failures log the primary tag PLUS a `secondary_cause`
 * field" holds.
 */
function detectSecondarySignal(sig: FailureSignal): GithubFailureTag | undefined {
	if (sig.body && RATE_LIMIT_BODY_RE.test(sig.body)) {
		const ceiling = parseRateLimitCeiling(sig.headers)
		// Only "anon" if the ceiling actually says so, otherwise skip — we
		// don't want to mislabel an authenticated secondary rate-limit as anon.
		if (ceiling != null && ceiling <= 60) return 'anon-rate-limit'
	}
	return undefined
}

/**
 * Async classifier — probes the installation ID when the failure is 401 so
 * `token-expired-mid-session` catches the mid-session App reinstall case even
 * when mint-age is under threshold.
 */
export async function classifyGithubFailureAsync(sig: FailureSignal): Promise<FailureTag> {
	if (sig.status !== 401 || !sig.tokenContext) {
		return classifyGithubFailure(sig)
	}
	// Skip the probe if mint-age already crosses the threshold — it's already
	// enough to tag token-expired-mid-session without a network round-trip.
	const age = (sig.now ?? Date.now()) - sig.tokenContext.mintedAt
	if (age >= TOKEN_EXPIRY_THRESHOLD_MS) {
		return classifyGithubFailure(sig)
	}
	const resolves = await probeInstallationResolves(sig.tokenContext.installationId)
	return classifyGithubFailure(sig, resolves)
}

/**
 * Extract a FailureSignal from an unknown thrown error. The MCP bridge
 * surfaces provider errors as thrown `Error` instances with a stringified
 * body; this helper pulls out status + body so the classifier can run.
 */
export function extractSignalFromError(err: unknown): FailureSignal {
	if (err && typeof err === 'object') {
		const rec = err as Record<string, unknown>
		const status = typeof rec.status === 'number' ? rec.status : undefined
		const bodyRaw = rec.body ?? rec.message
		const body = typeof bodyRaw === 'string' ? bodyRaw : bodyRaw ? String(bodyRaw) : undefined
		const headers = (rec.headers as Record<string, string | undefined> | undefined) ?? undefined
		return { status, body, headers }
	}
	return { body: String(err) }
}

/**
 * Attach the classified tag to an Error so downstream consumers (retry
 * policy, alert dashboard) can read it without re-classifying.
 */
export function attachTag(err: Error, tag: FailureTag): Error & { causeTag: FailureTag } {
	const tagged = err as Error & { causeTag: FailureTag }
	tagged.causeTag = tag
	return tagged
}

export interface WrapContext {
	/** Tool name for log correlation. */
	toolName: string
	/** Was an Authorization header attached to the outbound call? */
	hadToken: boolean
	/** Token mint metadata — required for the token-expired-mid-session tag. */
	tokenContext?: TokenContext
}

/**
 * Wrap a single GitHub tool call. On failure: classify, emit one structured
 * session-log line with the cause tag, attach the tag to the error, rethrow.
 * On success: pass through the result unchanged.
 */
export async function wrapGithubToolCall<T>(ctx: WrapContext, exec: () => Promise<T>): Promise<T> {
	try {
		return await exec()
	} catch (err) {
		const raw = extractSignalFromError(err)
		const sig: FailureSignal = {
			...raw,
			hadToken: ctx.hadToken,
			tokenContext: ctx.tokenContext,
		}
		const tag = await classifyGithubFailureAsync(sig)
		const mintAgeSeconds = ctx.tokenContext
			? Math.round((Date.now() - ctx.tokenContext.mintedAt) / 1000)
			: undefined
		logger.error('github tool call failed', {
			provider: 'github',
			tool_name: ctx.toolName,
			cause_tag: tag.cause,
			secondary_cause: tag.secondary_cause,
			reason: tag.reason,
			installation_id: ctx.tokenContext?.installationId,
			mint_age_seconds: mintAgeSeconds,
			status: sig.status,
		})
		const wrapped = err instanceof Error ? err : new Error(String(err))
		throw attachTag(wrapped, tag)
	}
}
