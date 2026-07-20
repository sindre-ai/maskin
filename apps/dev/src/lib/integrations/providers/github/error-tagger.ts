/**
 * Classify every GitHub tool failure into a single cause tag, and expose a
 * wrapper that consumers can drop around any GitHub tool call so no failure
 * ever leaves the tool-call layer untagged.
 *
 * The tag set is the parent bet's AC-6 glossary plus one addition:
 * `token-expired-mid-session` — a 401 where the token was valid at session
 * start but crossed GitHub's 1-hour installation-token TTL before the write,
 * or where the installation ID resolved at mint time no longer resolves at
 * call time. That distinguishes the mid-session expiry pattern from a
 * generic 401 so the diagnostic first-move (token-mint delta,
 * installation-ID churn) can trigger without waiting on a human.
 *
 * Kept as a self-contained module so this task does not overlap with T4's
 * mint / refresh work in `auth.ts` — T4 stamps tokens with the metadata this
 * classifier reads, but neither task edits the other's file.
 */

import { logger } from '../../../logger'
import { type TokenMetadata, getTokenAgeSeconds, isTokenPossiblyStale } from './token-metadata'

export type GithubErrorCause =
	| 'missing-token'
	| 'anon-rate-limit'
	| '403-permission'
	| '401-unauth'
	| 'schema-validation'
	| 'mergeable-blocked'
	| 'token-expired-mid-session'

export interface HeaderLookup {
	get(name: string): string | null
}

/**
 * Normalised shape the classifier accepts. Callers can build one directly
 * from a `Response` (HTTP path) or from a thrown Error whose message
 * embeds a status code — `fromResponse` / `fromError` below are the
 * standard adapters.
 */
export interface GithubFailureInput {
	/** False when no token was attached to the request (`missing-token`). */
	hadToken: boolean
	/** HTTP status, when the failure was an HTTP response. */
	status?: number
	/** Header lookup for the response — used to spot the anon rate-limit case. */
	headers?: HeaderLookup
	/** Response body text (may be truncated) — used for mergeable / schema hints. */
	body?: string
	/** Raw error message when the failure was a thrown Error, not an HTTP response. */
	errorMessage?: string
}

export interface ClassificationContext {
	/** Present when the caller was using a stamped installation token. */
	tokenMeta?: TokenMetadata | null
	/**
	 * Present when the caller ran an installation-ID resolve probe.
	 * `false` means the installation ID no longer resolves (App reinstalled
	 * mid-session, ID rotated). `true` means it still resolves.
	 */
	installationResolves?: boolean
	/** Override the wall-clock — for tests. */
	now?: Date
}

export interface ClassifiedError {
	cause_tag: GithubErrorCause
	secondary_cause?: GithubErrorCause
	installation_id?: string
	mint_age_seconds?: number
}

const SCHEMA_HINT_RE =
	/\b(pull_number|issue_number|expected number|expected string|received string|received number|invalid_type|zod)\b/i
const MERGEABLE_HINT_RE = /\b(mergeable(_state)?|dirty|blocked|behind|not[_ ]?mergeable)\b/i
const ANON_RATE_LIMIT_HINT_RE = /API rate limit exceeded/i
const RATE_LIMIT_LIMIT_HEADER = 'x-ratelimit-limit'
const RATE_LIMIT_REMAINING_HEADER = 'x-ratelimit-remaining'

/**
 * Classify a GitHub tool failure into exactly one cause tag, plus an
 * optional `secondary_cause` when two independent signals fired. Decision
 * order (first match wins for the primary):
 *
 *   1. `missing-token` — no token attached
 *   2. `anon-rate-limit` — 403/429 with the anon rate-limit body + tiny limit
 *   3. `mergeable-blocked` — 405/409 with mergeability hints in the body
 *   4. `schema-validation` — 422 or a body that looks like Zod / schema errors
 *   5. `token-expired-mid-session` — 401 with stamped token that is stale OR
 *      an installation ID that no longer resolves
 *   6. `401-unauth` — any other 401
 *   7. `403-permission` — any other 403
 */
export function classifyGithubError(
	failure: GithubFailureInput,
	ctx: ClassificationContext = {},
): ClassifiedError {
	const primary = pickPrimary(failure, ctx)
	const secondary = pickSecondary(primary, failure, ctx)
	const out: ClassifiedError = { cause_tag: primary }
	if (secondary) out.secondary_cause = secondary
	if (ctx.tokenMeta) {
		out.installation_id = ctx.tokenMeta.installationId
		out.mint_age_seconds = getTokenAgeSeconds(ctx.tokenMeta, ctx.now)
	}
	return out
}

function pickPrimary(failure: GithubFailureInput, ctx: ClassificationContext): GithubErrorCause {
	if (!failure.hadToken) return 'missing-token'

	const status = failure.status ?? extractStatusFromMessage(failure.errorMessage)
	const bodyText = joinBodyish(failure)

	if (isAnonRateLimit(failure, bodyText)) return 'anon-rate-limit'
	if (isMergeableBlocked(status, bodyText)) return 'mergeable-blocked'
	if (isSchemaValidation(status, bodyText)) return 'schema-validation'
	if (status === 401 && isTokenExpiredMidSession(ctx)) return 'token-expired-mid-session'
	if (status === 401) return '401-unauth'
	if (status === 403) return '403-permission'
	// Fall back to a 401-unauth reading when the failure lacks a status but
	// carries an auth-shaped body — better than dropping the tag entirely.
	if (/Bad credentials|401|Requires authentication/i.test(bodyText)) return '401-unauth'
	// Everything else that reaches this point is an untypeable failure; tag
	// it as `401-unauth` only when body-hints agree, otherwise return
	// `schema-validation` as the least-wrong "we don't know" bucket. In
	// practice callers should always pass a status.
	return 'schema-validation'
}

function pickSecondary(
	primary: GithubErrorCause,
	failure: GithubFailureInput,
	ctx: ClassificationContext,
): GithubErrorCause | undefined {
	const status = failure.status ?? extractStatusFromMessage(failure.errorMessage)
	const bodyText = joinBodyish(failure)

	// Record a secondary_cause when a different signal ALSO fired. The
	// secondary detectors are deliberately looser than the primary
	// ones: primary rules discount some body hints against a specific
	// status (e.g. a 401 body can't primary-tag as schema), but for
	// ambiguity-signalling we want the second reading recorded so the
	// diagnostic first-move still has both cues.
	if (primary !== 'token-expired-mid-session' && status === 401 && isTokenExpiredMidSession(ctx)) {
		return 'token-expired-mid-session'
	}
	if (primary !== 'mergeable-blocked' && MERGEABLE_HINT_RE.test(bodyText)) {
		return 'mergeable-blocked'
	}
	if (primary !== 'schema-validation' && SCHEMA_HINT_RE.test(bodyText)) {
		return 'schema-validation'
	}
	if (primary !== '403-permission' && status === 403 && !isAnonRateLimit(failure, bodyText)) {
		return '403-permission'
	}
	return undefined
}

function isAnonRateLimit(failure: GithubFailureInput, bodyText: string): boolean {
	if (!ANON_RATE_LIMIT_HINT_RE.test(bodyText)) return false
	const limitRaw = failure.headers?.get(RATE_LIMIT_LIMIT_HEADER)
	const remainingRaw = failure.headers?.get(RATE_LIMIT_REMAINING_HEADER)
	const limit = safeInt(limitRaw)
	const remaining = safeInt(remainingRaw)
	// Anon per-IP quota is 60/hr — a limit at or below 60 is the tell.
	if (limit !== null && limit <= 60) return true
	// No limit header — accept the anon reading only when remaining is 0
	// AND the body carried the rate-limit phrase.
	if (limit === null && remaining === 0) return true
	return false
}

function isSchemaValidation(status: number | undefined, bodyText: string): boolean {
	if (status === 422) return true
	// Only trust body hints when the status is client-validation-shaped or
	// absent. A 401/403/409/500 body that happens to mention "expected
	// number" is not a schema failure — it's an auth / merge / server
	// failure whose body borrowed the phrasing.
	if (status !== undefined && status !== 400) return false
	return SCHEMA_HINT_RE.test(bodyText)
}

function isMergeableBlocked(status: number | undefined, bodyText: string): boolean {
	if (status !== 405 && status !== 409) return false
	return MERGEABLE_HINT_RE.test(bodyText)
}

function isTokenExpiredMidSession(ctx: ClassificationContext): boolean {
	if (ctx.installationResolves === false) return true
	if (ctx.tokenMeta && isTokenPossiblyStale(ctx.tokenMeta, ctx.now)) return true
	return false
}

function joinBodyish(failure: GithubFailureInput): string {
	return [failure.body, failure.errorMessage].filter((s): s is string => Boolean(s)).join('\n')
}

function extractStatusFromMessage(msg: string | undefined): number | undefined {
	if (!msg) return undefined
	const match = msg.match(/\b(4\d\d|5\d\d)\b/)
	if (!match) return undefined
	const n = Number(match[1])
	return Number.isFinite(n) ? n : undefined
}

function safeInt(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined) return null
	const n = Number.parseInt(raw, 10)
	return Number.isFinite(n) ? n : null
}

/**
 * Build a `GithubFailureInput` from a `fetch` `Response`. Reads the response
 * body once — callers must not have already consumed it.
 */
export async function fromResponse(
	res: Response,
	opts: { hadToken: boolean; bodyLimit?: number } = { hadToken: true },
): Promise<GithubFailureInput> {
	const limit = opts.bodyLimit ?? 2000
	let body = ''
	try {
		const raw = await res.text()
		body = raw.length > limit ? raw.slice(0, limit) : raw
	} catch {
		// swallow — body is best-effort
	}
	return {
		hadToken: opts.hadToken,
		status: res.status,
		headers: res.headers,
		body,
	}
}

/**
 * Build a `GithubFailureInput` from a thrown `Error`. Pulls status out of
 * the message when the message follows the `status: NNN` shape used by the
 * MCP callTool errors.
 */
export function fromError(
	err: unknown,
	opts: { hadToken: boolean } = { hadToken: true },
): GithubFailureInput {
	const msg = err instanceof Error ? err.message : String(err)
	return {
		hadToken: opts.hadToken,
		status: extractStatusFromMessage(msg),
		errorMessage: msg,
	}
}

/**
 * Attached to every rethrown error so downstream consumers (retry policies,
 * alerters, dashboards — all out of scope for this task) can read the tag
 * without re-classifying.
 */
export class TaggedGithubError extends Error {
	readonly cause_tag: GithubErrorCause
	readonly secondary_cause?: GithubErrorCause
	readonly installation_id?: string
	readonly mint_age_seconds?: number

	constructor(message: string, classified: ClassifiedError, cause?: unknown) {
		super(message)
		this.name = 'TaggedGithubError'
		this.cause_tag = classified.cause_tag
		this.secondary_cause = classified.secondary_cause
		this.installation_id = classified.installation_id
		this.mint_age_seconds = classified.mint_age_seconds
		if (cause !== undefined) {
			// Node's Error `cause` is a public field on Error since Node 16.9.
			;(this as unknown as { cause: unknown }).cause = cause
		}
	}
}

export interface WrapContext {
	/** Which GitHub tool was called — logged verbatim so grep-by-tool works. */
	toolName: string
	tokenMeta?: TokenMetadata | null
	hadToken: boolean
	/**
	 * Optional. When present, the wrapper calls this on a 401 to decide
	 * `token-expired-mid-session` vs plain `401-unauth`. Return `true` if
	 * the installation ID still resolves against the App's JWT, `false` if
	 * it does not.
	 */
	resolveInstallation?: (installationId: string) => Promise<boolean>
}

/**
 * Wrap a single GitHub tool call. Catches every error thrown by `fn`,
 * classifies it, emits one structured `logger.error` with the fields
 * consumers of the AC-6 glossary need to grep on, and rethrows a
 * `TaggedGithubError` so the tag is visible on the rethrown exception.
 *
 * Success paths pass through unchanged. Callers who fetch a `Response` and
 * detect a non-2xx should either throw + let the wrapper catch it, or hand
 * the `Response` to `fromResponse` and rethrow — this wrapper only wraps
 * error paths.
 */
export async function wrapGithubToolCall<T>(fn: () => Promise<T>, ctx: WrapContext): Promise<T> {
	try {
		return await fn()
	} catch (err) {
		const failure =
			err instanceof Error
				? fromError(err, { hadToken: ctx.hadToken })
				: fromError(err, { hadToken: ctx.hadToken })

		let installationResolves: boolean | undefined
		if (failure.status === 401 && ctx.tokenMeta && ctx.resolveInstallation) {
			try {
				installationResolves = await ctx.resolveInstallation(ctx.tokenMeta.installationId)
			} catch {
				// A resolve probe that itself 401s is a strong signal the ID
				// no longer resolves.
				installationResolves = false
			}
		}

		const classified = classifyGithubError(failure, {
			tokenMeta: ctx.tokenMeta,
			installationResolves,
		})

		logger.error('github tool call failed', {
			tool: ctx.toolName,
			cause_tag: classified.cause_tag,
			secondary_cause: classified.secondary_cause,
			installation_id: classified.installation_id,
			mint_age_seconds: classified.mint_age_seconds,
			status: failure.status,
			error: err instanceof Error ? err.message : String(err),
		})

		throw new TaggedGithubError(err instanceof Error ? err.message : String(err), classified, err)
	}
}
