/**
 * UUID v1-v5 regex (lowercase or uppercase). Anchored callers add their own
 * word-boundary guards — when used with `matchAll` against arbitrary message
 * text, we rely on the `g` flag plus a non-alphanumeric / start-of-string
 * lookaround on each side to avoid grabbing UUIDs embedded inside identifiers.
 */
const UUID_PATTERN =
	/(?<![0-9A-Za-z-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z-])/gi

export interface TextPart {
	type: 'text'
	value: string
}
export interface UuidPart {
	type: 'uuid'
	value: string
}
export type Part = TextPart | UuidPart

/**
 * Split a string into alternating text and UUID parts. Empty text segments
 * between adjacent UUIDs are dropped so consumers don't render empty spans.
 */
export function splitTextByUuids(content: string): Part[] {
	if (!content) return []
	const parts: Part[] = []
	let cursor = 0
	const matches = content.matchAll(UUID_PATTERN)
	for (const match of matches) {
		const start = match.index ?? 0
		if (start > cursor) parts.push({ type: 'text', value: content.slice(cursor, start) })
		parts.push({ type: 'uuid', value: match[0] })
		cursor = start + match[0].length
	}
	if (cursor < content.length) parts.push({ type: 'text', value: content.slice(cursor) })
	return parts
}
