const FAILURE_REASON_MAX_CHARS = 200

/** The two fields of a session's result that a short failure line is built from. */
interface FailureSource {
	error?: string | null
	failure_reason?: { human_message?: string | null } | null
}

/**
 * One line, trimmed to 200 characters. Prefers the classified human message over
 * the free-text error; the verbatim provider output, logs and tool arguments are
 * never read, so callers can hand this to any reader of the session.
 */
export function shortFailureReason(result: FailureSource | null | undefined): string | null {
	const text = (result?.failure_reason?.human_message || result?.error || '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!text) return null
	return text.length > FAILURE_REASON_MAX_CHARS
		? `${text.slice(0, FAILURE_REASON_MAX_CHARS - 1)}…`
		: text
}

/** The short failure line, set only when the session failed. */
export function sessionFailureReason(
	status: string,
	result: FailureSource | null | undefined,
): string | null {
	return status === 'failed' ? shortFailureReason(result) : null
}
