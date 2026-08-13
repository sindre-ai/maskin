// Strip external image references from an agent-supplied email body before
// it is rendered or sent to Resend. Prevents the exfil chain where an agent
// embeds `<img src="http://attacker/…">` and the recipient's mail client fires
// a GET on preview, leaking read receipts or session context.
//
// Rule: only `data:image/*` URIs are allowed. Everything else — http(s),
// protocol-relative `//host`, `cid:`, or a relative path — is treated as
// external and replaced with a plain-text placeholder. Callers should invoke
// this on the raw `bodyText` before any templating or HTML rendering.

export interface StripExternalImagesResult {
	bodyText: string
	removed: number
}

const PLACEHOLDER = '[external image removed]'

function isDataImageUri(url: string): boolean {
	return /^data:image\//i.test(url.trim())
}

// Matches any `<img …>` tag (self-closing or not, attributes optional).
const IMG_TAG_RE = /<img\b[^>]*>/gi

// Matches Markdown image syntax: `![alt](url)` or `![alt](url "title")`.
// The url capture stops at whitespace or `)` so an optional title is excluded.
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/g

// Matches CSS `url(...)`, quoted or unquoted, in <style> blocks or inline
// `style="…"` attributes. Kept intentionally permissive on whitespace.
const CSS_URL_RE = /\burl\s*\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/gi

function extractImgSrc(tag: string): string | null {
	const quoted = /\bsrc\s*=\s*(['"])([\s\S]*?)\1/i.exec(tag)
	if (quoted) return quoted[2] ?? null
	const unquoted = /\bsrc\s*=\s*([^\s>]+)/i.exec(tag)
	return unquoted?.[1] ?? null
}

export function stripExternalImages(bodyText: string): StripExternalImagesResult {
	let removed = 0

	let out = bodyText.replace(IMG_TAG_RE, (tag) => {
		const src = extractImgSrc(tag)
		if (src && isDataImageUri(src)) return tag
		removed += 1
		return PLACEHOLDER
	})

	out = out.replace(MD_IMAGE_RE, (match, _alt, url: string) => {
		if (isDataImageUri(url)) return match
		removed += 1
		return PLACEHOLDER
	})

	out = out.replace(CSS_URL_RE, (match, q1: string, q2: string, bare: string) => {
		const url = q1 ?? q2 ?? bare ?? ''
		if (isDataImageUri(url)) return match
		removed += 1
		return 'url()'
	})

	return { bodyText: out, removed }
}
