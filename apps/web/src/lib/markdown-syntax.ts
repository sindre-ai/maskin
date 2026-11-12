// A line that opens a block: bullet, number, quote or fence.
const BLOCK_LINE_RE = /^ {0,3}(?:[-*+] |\d{1,9}[.)] |> ?\S|```|~~~)/m
// A table needs its separator row: `| --- | --- |` or `--- | ---`.
const TABLE_SEPARATOR_RE = /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m
// Inline marks around text: **bold**, *italic*, ~~strike~~, `code`, [text](url). The mark hugs its
// text, so "2 * 3 * 4" and a lone "*" stay plain.
const INLINE_RE =
	/\*\*[^\s*][^*]*\*\*|(?<![\w*])\*[^\s*][^*\n]*\*(?![\w*])|~~[^\s~][^~]*~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/

/**
 * Whether a message you wrote holds markdown that should be drawn formatted, as the messages of
 * everyone else in the chat are. Text with none of it keeps its own plain rendering.
 */
export function hasMarkdownSyntax(text: string): boolean {
	return BLOCK_LINE_RE.test(text) || TABLE_SEPARATOR_RE.test(text) || INLINE_RE.test(text)
}
