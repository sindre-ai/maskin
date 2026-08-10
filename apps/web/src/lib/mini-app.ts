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
// 'none'` is the v1 static-app egress lock: nothing inside the frame can open a
// network connection, so an agent-authored app cannot exfiltrate. An agent CSP
// meta that slips through the strip can only add restrictions, never relax
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

// Inserts a fragment into a document, preferring <head>, then after the
// doctype declaration's closing `>`, then before <body>, else prepends — so
// the fragment never precedes a <!DOCTYPE> declaration. Shared by the
// annotation-listener injection and the mini-app header injection.
export function injectIntoHtml(html: string, fragment: string): string {
	const lower = html.toLowerCase()
	const headIdx = lower.indexOf('<head>')
	if (headIdx !== -1) {
		return html.slice(0, headIdx + 6) + fragment + html.slice(headIdx + 6)
	}
	const doctypeIdx = lower.indexOf('<!doctype')
	if (doctypeIdx !== -1) {
		const closeIdx = html.indexOf('>', doctypeIdx)
		if (closeIdx !== -1) {
			return html.slice(0, closeIdx + 1) + fragment + html.slice(closeIdx + 1)
		}
	}
	const bodyIdx = lower.indexOf('<body')
	if (bodyIdx !== -1) {
		return html.slice(0, bodyIdx) + fragment + html.slice(bodyIdx)
	}
	return fragment + html
}

// Removes any agent-authored CSP <meta> so the platform owns the policy. The
// regex tolerates whitespace, mixed case, and quoted/unquoted http-equiv.
const CSP_META_RE = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi
export function stripAgentCsp(html: string): string {
	return html.replace(CSP_META_RE, '')
}

// Platform footer for a mini-app document: platform CSP meta + data-slot
// bootstrap. Scoped to the HTML render paths in the viewer — non-HTML file
// types never touch this.
export function prepareMiniAppHtml(html: string): string {
	const scrubbed = stripAgentCsp(html)
	return injectIntoHtml(scrubbed, CSP_META + DATA_SLOT_BOOTSTRAP)
}
