// The file viewer renders text/html in a sandboxed frame whose CSP blocks all
// outside scripts, stylesheets, fonts and images, and whose sandbox throws on
// localStorage / sessionStorage. The save still succeeds; this builds the note
// the caller reads so the author learns about it before the viewer shows a
// broken page. Do not loosen the CSP — egress is locked on purpose.

const MAX_LISTED_URLS = 3

const EMBED_TAG_RE = /<(script|img|link|source|video|audio|iframe)\b[^>]*>/gi
const TAG_URL_RE = /\b(?:src|href)\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)/i
const LOADED_LINK_RE = /\brel\s*=\s*["']?(?:stylesheet|preload|modulepreload)/i
const CSS_URL_RE = /(?:@import\s+(?:url\()?|url\()\s*["']?\s*((?:https?:)?\/\/[^\s"')]+)/gi
const STORAGE_RE = /\b(localStorage|sessionStorage)\b/g

export function htmlViewerWarning(mimeType: string, html: string): string | undefined {
	if (mimeType.toLowerCase() !== 'text/html') return undefined

	const urls = new Set<string>()
	for (const [tag, name] of html.matchAll(EMBED_TAG_RE)) {
		if (name?.toLowerCase() === 'link' && !LOADED_LINK_RE.test(tag)) continue
		const url = TAG_URL_RE.exec(tag)?.[1]
		if (url) urls.add(url)
	}
	for (const [, url] of html.matchAll(CSS_URL_RE)) {
		if (url) urls.add(url)
	}
	const storage = new Set([...html.matchAll(STORAGE_RE)].map((m) => m[1]))

	const problems: string[] = []
	if (urls.size > 0) {
		const listed = [...urls].slice(0, MAX_LISTED_URLS).join(', ')
		const more = urls.size > MAX_LISTED_URLS ? ` and ${urls.size - MAX_LISTED_URLS} more` : ''
		problems.push(`it loads outside resources (${listed}${more}), which the viewer blocks`)
	}
	if (storage.size > 0) {
		problems.push(`it uses ${[...storage].join(' and ')}, which throws in the viewer sandbox`)
	}
	if (problems.length === 0) return undefined

	return `The file was saved, but the file viewer will not show it as written: ${problems.join('; ')}. The page will look unstyled or broken. Inline all scripts, styles, fonts and images into the file and do not use browser storage. See the viewer-safe-html skill.`
}
