/**
 * Splits markdown source into the delimiter runs and the text between them, so
 * an editor overlay can push `**`, `_` and `` ` `` into the background while
 * the prose stays at full contrast.
 *
 * Only *paired* delimiters are reported — a lone asterisk in running text is
 * not a marker and must not be dimmed. This is a reading hint, not a parser:
 * it deliberately ignores nesting, escapes and code fences, because the worst
 * case is a delimiter rendered at normal contrast, which is what it looks like
 * today anyway.
 */
export interface MarkdownSegment {
	text: string
	isMarker: boolean
}

// `**bold**`, `_italic_`, `` `code` `` — the three the editor's shortcuts write.
const PAIRED = /(\*\*)([\s\S]+?)(\*\*)|(_)([^_\n]+?)(_)|(`)([^`\n]+?)(`)/g

export function splitMarkdownMarkers(source: string): MarkdownSegment[] {
	const segments: MarkdownSegment[] = []
	let cursor = 0

	const push = (text: string, isMarker: boolean) => {
		if (!text) return
		const last = segments[segments.length - 1]
		// Merge runs of the same kind so the overlay renders as few spans as it can.
		if (last && last.isMarker === isMarker) last.text += text
		else segments.push({ text, isMarker })
	}

	PAIRED.lastIndex = 0
	let match = PAIRED.exec(source)
	while (match !== null) {
		push(source.slice(cursor, match.index), false)
		// Exactly one alternative matched, so its three groups are the open
		// delimiter, the content, and the close delimiter.
		const groups = match.slice(1).filter((group) => group !== undefined)
		const [open, content, close] = groups
		push(open ?? '', true)
		push(content ?? '', false)
		push(close ?? '', true)
		cursor = match.index + match[0].length
		match = PAIRED.exec(source)
	}
	push(source.slice(cursor), false)

	return segments
}
