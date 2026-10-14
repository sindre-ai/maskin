/**
 * The one slice of a contact's description Astrid may speak from: the section headed "Call context".
 * Everything else in the description (strategy, scoring, tier, rejection reasons) stays out of the
 * call, so this returns the section text and nothing around it.
 */

/** Keeps the prompt small and the agent's turns short. */
export const CALL_CONTEXT_MAX_CHARS = 600

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/
const CALL_CONTEXT_TITLE = /^call context:?$/i

/**
 * The text under the first "Call context" heading, up to the next heading of any level, with
 * whitespace collapsed and capped at CALL_CONTEXT_MAX_CHARS. Empty when there is no such section,
 * it holds no text, or the description is missing.
 */
export function extractCallContext(description: string | null | undefined): string {
	if (!description) return ''
	const lines = description.split(/\r\n|\r|\n/)
	const start = lines.findIndex((line) => {
		const title = HEADING.exec(line)?.[1]
		return title !== undefined && CALL_CONTEXT_TITLE.test(title.trim())
	})
	if (start === -1) return ''
	const body: string[] = []
	for (const line of lines.slice(start + 1)) {
		if (HEADING.test(line)) break
		body.push(line)
	}
	const text = body.join(' ').replace(/\s+/g, ' ').trim()
	// Spread counts code points, so a cut never lands inside a surrogate pair.
	return [...text].slice(0, CALL_CONTEXT_MAX_CHARS).join('').trimEnd()
}
