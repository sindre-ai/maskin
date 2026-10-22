/**
 * A readable one-line title for a session, taken from its stored action prompt.
 * The web handoff list and the graph endpoints both use it, so a session reads
 * the same wherever it is listed.
 *
 * The first line of a prompt is rarely what a person wants to see. A session
 * started by a comment opens with the "Sent by <agent>, another agent..." safety
 * line and then a paragraph of instructions, so titling it by its first line
 * gave every one of those sessions the same unreadable heading.
 */

const SENDER_LINE = /^Sent by /
/** The quoted comment a comment-started session was woken for. */
const COMMENT_BLOCK = /(?:Comment content|New comment content):\s*\n"""\n([\s\S]*?)\n"""/

function firstLine(text: string): string | undefined {
	return text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0)
}

function clip(line: string, max: number): string {
	return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/**
 * Title for a session: the comment it was woken for if it was started by one,
 * otherwise the first real line of its prompt, with the sender line skipped.
 * Null when the prompt has nothing to title it by.
 */
export function sessionTitleFromPrompt(
	actionPrompt: string | null | undefined,
	max = 80,
): string | null {
	const prompt = (actionPrompt ?? '').trim()
	if (!prompt) return null

	const comment = COMMENT_BLOCK.exec(prompt)?.[1]
	const commentLine = comment ? firstLine(comment) : undefined
	if (commentLine) return clip(commentLine, max)

	const line = prompt
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !SENDER_LINE.test(l))
	return line ? clip(line, max) : null
}
