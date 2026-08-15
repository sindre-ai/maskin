// Platform-owned security + data seam for rendered mini-app HTML (text/html
// files shown in the viewer). The architecture decision (2026-08-10) fixes:
//   - keep the sandboxed iframe (`sandbox="allow-scripts"`, null origin)
//   - deliver an immutable CSP the frame's own JS cannot relax
//   - expose `<script id="maskin-state" type="application/json">` (the build-time
//     data slot) as `window.__MASKIN_APP_DATA__`
//
// There is no raw-HTML HTTP serve path today — file bytes come back as JSON
// (`apps/dev/src/routes/files.ts`) and the viewer materialises the document via
// `srcdoc`. So the platform CSP is injected here, at the point the document is
// actually created, after stripping any agent-authored CSP meta. `connect-src
// 'none'` is the v1 static-app egress lock for resource/fetch-class connections
// (fetch, XHR, WebSocket, beacon, form submission, external images/scripts).
// Scripted self-navigation (`location.href = ...`) is NOT governed by any CSP
// directive in Chromium, so it remains possible — closing that channel is v2
// work (a real origin + Fetch Metadata / bridge). `stripMetaRefresh` removes
// the one silent, code-free navigation channel a static document can use. Agent
// CSP metas that slip through the strip can only add restrictions, never relax
// ours — browsers enforce every CSP meta in the document.

export const MINI_APP_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"script-src 'unsafe-inline'",
	'img-src data:',
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join('; ')

export const DATA_SLOT_ID = 'maskin-state'
export const APP_DATA_GLOBAL = '__MASKIN_APP_DATA__'

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${MINI_APP_CSP}">`

// Reads the declared data slot on every access and exposes it as
// window.__MASKIN_APP_DATA__. The getter makes the contract timing-independent
// (the slot node may sit anywhere in the document) and is the exact seam a
// future dynamic bridge reuses: v2 swaps this getter's population source
// without touching the app-facing global. Missing/invalid data yields null.
const DATA_SLOT_BOOTSTRAP = `<script>Object.defineProperty(window,'${APP_DATA_GLOBAL}',{configurable:true,get:function(){var n=document.getElementById('${DATA_SLOT_ID}');if(!n)return null;try{return JSON.parse(n.textContent||'{}')}catch(e){return null}}});</script>`

// Advances past the tag that starts at `start` (which points at `<`), returning
// the index just past its closing `>`. A `>` inside a quoted attribute value is
// part of the value, not the end of the tag.
function tagEnd(html: string, start: number): number {
	let i = start + 1
	let quote: string | null = null
	while (i < html.length) {
		const ch = html[i]
		if (quote) {
			if (ch === quote) quote = null
		} else if (ch === '"' || ch === "'") {
			quote = ch
		} else if (ch === '>') {
			return i + 1
		}
		i += 1
	}
	return -1
}

// Raw-text/RCDATA elements, plus blocks whose content is usually shown or
// parsed verbatim (pre/code) and inert containers (template): a `<head>`-shaped
// token inside any of these is text, not the document's real head.
const NON_ELIGIBLE = /^(script|style|textarea|title|pre|code|template)$/i
const OPEN_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])/
const DOCTYPE_RE = /^<!doctype(?=[\s>])/i

interface Token {
	kind: 'open' | 'decl'
	name: string
	start: number
	end: number
}

// Byte-preserving walk over the document that yields the first token matching
// `pred`, skipping comment/CDATA spans and the bodies of raw-text elements so a
// `<head>` inside a script string or code block is never mistaken for a tag.
function firstToken(html: string, pred: (t: Token) => boolean): Token | null {
	let i = 0
	while (i < html.length) {
		const lt = html.indexOf('<', i)
		if (lt === -1) return null
		const rest = html.slice(lt)
		if (rest.startsWith('<!--')) {
			const close = html.indexOf('-->', lt + 4)
			if (close === -1) return null
			i = close + 3
			continue
		}
		if (rest.startsWith('<![CDATA[')) {
			const close = html.indexOf(']]>', lt + 9)
			if (close === -1) return null
			i = close + 3
			continue
		}
		const open = OPEN_TAG_RE.exec(rest)
		if (open) {
			const name = open[1].toLowerCase()
			if (NON_ELIGIBLE.test(name)) {
				const openEnd = tagEnd(html, lt)
				if (openEnd === -1) return null
				const closeRe = new RegExp(`</${name}\\s*>`, 'i')
				const close = closeRe.exec(html.slice(openEnd))
				if (!close) return null
				i = openEnd + close.index + close[0].length
				continue
			}
			const end = tagEnd(html, lt)
			if (end === -1) return null
			const token: Token = { kind: 'open', name, start: lt, end }
			if (pred(token)) return token
			i = end
			continue
		}
		const decl = DOCTYPE_RE.exec(rest)
		if (decl) {
			const end = tagEnd(html, lt)
			if (end === -1) return null
			const token: Token = { kind: 'decl', name: '!doctype', start: lt, end }
			if (pred(token)) return token
			i = end
			continue
		}
		i = lt + 1
	}
	return null
}

// Inserts a fragment into a document, preferring a real <head> open tag (any
// casing, with or without attributes), then after the doctype declaration, then
// before <body>, else prepends — so the fragment never precedes a <!DOCTYPE>
// declaration. Shared by the annotation-listener injection and the mini-app
// header injection. Placement is a scan, not a substring search: a `<head>`
// token inside a script string, RCDATA element, or code block is text, and
// inserting into it would leave the injected tags inert or corrupt the
// document.
export function injectIntoHtml(html: string, fragment: string): string {
	const head = firstToken(html, (t) => t.kind === 'open' && t.name === 'head')
	if (head) return html.slice(0, head.end) + fragment + html.slice(head.end)
	const doctype = firstToken(html, (t) => t.kind === 'decl' && t.name === '!doctype')
	if (doctype) return html.slice(0, doctype.end) + fragment + html.slice(doctype.end)
	const body = firstToken(html, (t) => t.kind === 'open' && t.name === 'body')
	if (body) return html.slice(0, body.start) + fragment + html.slice(body.start)
	return fragment + html
}

// Removes any agent-authored CSP <meta> so the platform owns the policy. The
// regex tolerates whitespace, mixed case, and quoted/unquoted http-equiv.
const CSP_META_RE = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi
export function stripAgentCsp(html: string): string {
	return html.replace(CSP_META_RE, '')
}

// Removes any `<meta http-equiv="refresh">`. A refresh meta is the one silent,
// code-free navigation channel a static document can use (browsers honour it
// without script); stripping it keeps the v1 egress story honest. Scripted
// self-navigation is documented as a v1 limitation in the header comment.
const META_REFRESH_RE = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?[^>]*>/gi
export function stripMetaRefresh(html: string): string {
	return html.replace(META_REFRESH_RE, '')
}

// Platform footer for a mini-app document: platform CSP meta + data-slot
// bootstrap. Scoped to the HTML render paths in the viewer — non-HTML file
// types never touch this. Agent CSP metas are stripped first, then refresh
// metas, then the platform footer is placed by the byte-preserving scan.
export function prepareMiniAppHtml(html: string): string {
	const scrubbed = stripMetaRefresh(stripAgentCsp(html))
	return injectIntoHtml(scrubbed, CSP_META + DATA_SLOT_BOOTSTRAP)
}
