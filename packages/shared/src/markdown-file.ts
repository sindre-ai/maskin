const MARKDOWN_MIME = 'text/markdown'
const MARKDOWN_NAME_RE = /\.(md|markdown)$/i

/**
 * True when a file should be treated as Markdown: its MIME type is
 * text/markdown, or its name ends in .md or .markdown (case-insensitive).
 * The name check exists because agents often create .md files with a generic
 * type such as text/plain. One helper so the API, the web app and the review
 * flow cannot disagree.
 */
export function isMarkdownFile(file: { name: string; mimeType: string }): boolean {
	const mime = file.mimeType.split(';')[0]?.trim().toLowerCase()
	return mime === MARKDOWN_MIME || MARKDOWN_NAME_RE.test(file.name)
}
