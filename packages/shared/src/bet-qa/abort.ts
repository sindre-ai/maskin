/**
 * bet-qa: bypass-failure abort path.
 *
 * Shared between the local Docker and production microsandbox bet-qa runs.
 * The inline `bet-qa` skill body (T6) calls into these helpers when the
 * agent navigates to a preview and the `x-vercel-protection-bypass` header
 * is missing or rejected — we must emit a structured error event and post
 * an explicit "instrumentation gap" comment on the bet rather than
 * fabricate a passing evidence comment.
 *
 * Both code paths already pipe agent stdout into `session_logs`, so the
 * structured event is a single newline-terminated JSON line prefixed with
 * `[BET_QA_EVENT]` written to stdout. Consumers that want to parse the
 * stream filter on the prefix and JSON.parse the suffix.
 */

export type VercelBypassFailureReason = 'vercel_bypass_missing' | 'vercel_bypass_invalid'

export const BET_QA_EVENT_PREFIX = '[BET_QA_EVENT]'

/**
 * Shape of the structured event written to stdout (and from there into
 * `session_logs`). Stable wire contract — adding fields is fine, renaming
 * or removing them is a breaking change for any downstream consumer.
 */
export type BypassFailureEvent = {
	event: 'bet_qa_aborted'
	reason: VercelBypassFailureReason
	previewUrl: string
	sessionId: string
	betId: string
	occurredAt: string
}

export type PreviewProbeResponse = {
	status: number
	headers: Record<string, string>
	bodyText: string
}

/**
 * Classify a real preview navigation response. The deployment-protection
 * challenge from Vercel surfaces as either an HTTP 401 with a Set-Cookie
 * for `_vercel_sso_nonce`, or a 200/3xx response whose body contains the
 * SSO/Authentication-Required markup. Distinguishing missing from invalid
 * is done from the secret side at the call site (an empty/undefined
 * secret is `missing`; a present-but-rejected secret is `invalid`).
 *
 * Returns null when the response looks authenticated.
 */
export function classifyVercelBypassResponse(
	response: PreviewProbeResponse,
	bypassSecret: string | undefined | null,
): VercelBypassFailureReason | null {
	const looksLikeChallenge = isVercelDeploymentProtectionChallenge(response)
	if (!looksLikeChallenge) return null
	if (!bypassSecret || bypassSecret.trim() === '') return 'vercel_bypass_missing'
	return 'vercel_bypass_invalid'
}

function isVercelDeploymentProtectionChallenge(response: PreviewProbeResponse): boolean {
	if (response.status === 401 || response.status === 403) return true

	const headers = lowercaseHeaders(response.headers)
	const setCookie = headers['set-cookie'] ?? ''
	if (/_vercel_sso(_nonce)?=/.test(setCookie)) return true

	// Some Vercel projects redirect to `/sso-api` or `vercel.com/sso-api` instead
	// of returning 401 — surfaces as a 200 with redirect markup.
	if (/vercel\.com\/sso-api|\/sso-api\?/i.test(response.bodyText)) return true
	if (/Authentication Required/i.test(response.bodyText)) return true

	return false
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
	return out
}

export type FormatEventInput = {
	reason: VercelBypassFailureReason
	previewUrl: string
	sessionId: string
	betId: string
	now?: () => Date
}

/**
 * Format the structured event written to stdout. Returns both the parsed
 * event object (useful for tests and in-process consumers) and the literal
 * stdout line. The line is newline-terminated so a single `process.stdout.write`
 * call lands as one row in `session_logs`.
 */
export function formatBypassFailureEvent(input: FormatEventInput): {
	event: BypassFailureEvent
	line: string
} {
	const now = input.now ?? (() => new Date())
	const event: BypassFailureEvent = {
		event: 'bet_qa_aborted',
		reason: input.reason,
		previewUrl: input.previewUrl,
		sessionId: input.sessionId,
		betId: input.betId,
		occurredAt: now().toISOString(),
	}
	const line = `${BET_QA_EVENT_PREFIX} ${JSON.stringify(event)}\n`
	return { event, line }
}

/**
 * The exact comment body posted on the bet. Phrasing is fixed so reviewers
 * (human and Acceptance Validator) can grep for it. Never mention the
 * specific secret value or any other potentially sensitive detail.
 */
export function formatInstrumentationGapComment(input: {
	reason: VercelBypassFailureReason
	previewUrl: string
}): string {
	return [
		`instrumentation gap: preview auth failed — ${input.reason}`,
		'',
		'The bet-qa run was aborted before any interaction could be driven.',
		`Preview URL: ${input.previewUrl}`,
		'',
		'No evidence comment has been posted on this bet for this session.',
	].join('\n')
}

export type AbortBetQaInput = {
	previewUrl: string
	sessionId: string
	betId: string
	response: PreviewProbeResponse
	bypassSecret: string | undefined | null
	now?: () => Date
}

export type AbortBetQaDeps = {
	/**
	 * Writes the structured event line. In the agent runtime this is
	 * `(line) => process.stdout.write(line)`; tests pass a buffer.
	 */
	emitEvent: (line: string) => void | Promise<void>
	/**
	 * Posts the instrumentation-gap comment on the bet. In the agent runtime
	 * this wraps the Maskin `create_comment` API; tests pass a stub.
	 */
	postComment: (input: { betId: string; body: string }) => void | Promise<void>
}

export type AbortBetQaResult =
	| { aborted: false }
	| {
			aborted: true
			reason: VercelBypassFailureReason
			event: BypassFailureEvent
			eventLine: string
			commentBody: string
	  }

/**
 * Orchestrator. Classifies the preview response, and if the bypass auth
 * failed, emits the structured event AND posts the instrumentation-gap
 * comment, returning the materials for the caller to assert on. The
 * caller (T6's bet-qa skill) is responsible for stopping the skill —
 * `aborted: true` is the signal.
 *
 * The session itself stays alive; only the bet-qa skill aborts. Callers
 * must NOT use this to terminate the agent process.
 */
export async function abortBetQa(
	input: AbortBetQaInput,
	deps: AbortBetQaDeps,
): Promise<AbortBetQaResult> {
	const reason = classifyVercelBypassResponse(input.response, input.bypassSecret)
	if (reason === null) return { aborted: false }

	const { event, line } = formatBypassFailureEvent({
		reason,
		previewUrl: input.previewUrl,
		sessionId: input.sessionId,
		betId: input.betId,
		now: input.now,
	})
	const commentBody = formatInstrumentationGapComment({ reason, previewUrl: input.previewUrl })

	await deps.emitEvent(line)
	await deps.postComment({ betId: input.betId, body: commentBody })

	return { aborted: true, reason, event, eventLine: line, commentBody }
}
