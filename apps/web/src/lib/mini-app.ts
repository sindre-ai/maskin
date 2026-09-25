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

// postMessage type the viewer stage listens for to learn the natural document
// dimensions of the sandboxed iframe. Payload is the frame's
// `documentElement.scrollWidth/scrollHeight` at load + on resize.
export const VIEWER_DOC_SIZE_MESSAGE = 'maskin:viewer:doc-size'

// postMessage type the viewer stage listens for to receive wheel events that
// fired inside the sandboxed iframe. Sandboxed iframes swallow their own wheel
// events — they never bubble to the parent listener — so without forwarding,
// ctrl+wheel zoom and plain-scroll pan are dead wherever a user actually
// points (the document itself). Payload carries the deltas, the ctrl flag,
// and the cursor in the iframe's own document coordinate space (unscaled).
export const VIEWER_WHEEL_MESSAGE = 'maskin:viewer:wheel'

// One-line reporter script injected into the same platform footer as the CSP
// and data-slot bootstrap, so `prepareViewerHtml` still passes through a
// single `injectIntoHtml` call. Runs inside the sandboxed frame (null origin,
// no allow-same-origin) and posts to `window.parent` with `targetOrigin: '*'`
// because the frame has no origin of its own. The stage validates the source
// against its own iframe reference (`event.source === iframeRef.contentWindow`)
// before trusting either payload.
//
// Two responsibilities:
//   1. Report the natural document size on load + resize so the stage can
//      compute fit-to-screen against the frame's real dimensions.
//   2. Forward every wheel event to the parent, always calling
//      preventDefault: the iframe has no scroll room of its own (it's sized
//      to its content), so the default action either does nothing or falls
//      back to browser page zoom — both wrong. The parent's message handler
//      translates the payload into a stage zoom or a viewport scroll.
const VIEWER_REPORTER = `<script>(function(){function s(){try{var d=document.documentElement;parent.postMessage({type:'${VIEWER_DOC_SIZE_MESSAGE}',w:d.scrollWidth,h:d.scrollHeight},'*')}catch(e){}}if(document.readyState==='complete')s();else window.addEventListener('load',s);window.addEventListener('resize',s);window.addEventListener('wheel',function(e){try{parent.postMessage({type:'${VIEWER_WHEEL_MESSAGE}',deltaX:e.deltaX,deltaY:e.deltaY,ctrlKey:e.ctrlKey,docX:e.clientX,docY:e.clientY},'*');e.preventDefault()}catch(err){}},{passive:false})})();</script>`

// postMessage type the paging controller posts back to the stage on load and
// after every page change. Payload: `{ index, total, w, h }` where `w`/`h` are
// the ACTIVE slide's own scroll box — the stage derives fit k from the visible
// slide, not the whole deck (a deck's documentElement size is meaningless when
// one slide is on screen).
export const VIEWER_PAGE_MESSAGE = 'maskin:viewer:page'

// postMessage type the stage posts into the frame to change page. Payload:
// `{ page: number }` (zero-based slide index).
export const VIEWER_GOTO_PAGE_MESSAGE = 'maskin:viewer:goto-page'

// Slide selector — the same three signals viewer-detect.ts's DOM heuristic
// accepts as "this is a deck", so whatever resolved to `deck` is what the
// controller can page.
export const VIEWER_SLIDE_SELECTOR = '[data-slide], section.slide, [id^="slide"]'

// Applies the one-slide-at-a-time invariant to an already-collected slide
// list: the active slide keeps its natural display, every other slide gets
// `display: none`. Returns the clamped active index. Kept as a plain function
// over `(slides, index)` — no module-scope references — because the injected
// controller embeds its source via `toString()` (see below), which is what
// keeps the in-frame behaviour and the unit-tested behaviour the same code.
export function applyViewerPage(slides: HTMLElement[], index: number): number {
	if (slides.length === 0) return 0
	const clamped = Math.max(0, Math.min(index, slides.length - 1))
	for (let i = 0; i < slides.length; i++) {
		slides[i].style.display = i === clamped ? '' : 'none'
	}
	return clamped
}

export function collectViewerSlides(root: ParentNode): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(VIEWER_SLIDE_SELECTOR))
}

// Testable counterpart of the injected controller's `showPage(i)`: page the
// document rooted at `root` to `index`.
export function showViewerPage(root: ParentNode, index: number): number {
	return applyViewerPage(collectViewerSlides(root), index)
}

// Paging controller, injected only when the doc resolved to `deck`. Lives in
// the same platform footer as the doc-size reporter so `prepareViewerHtml`
// still makes exactly ONE `injectIntoHtml` call — a second injection would be
// the byte-preserving placement seam's failure mode, and would risk an
// `allow-same-origin` regression. Same source-window validation applies on the
// stage side: the frame posts with `targetOrigin: '*'` (null origin) and the
// stage checks `event.source === iframeRef.contentWindow`.
//
// Two responsibilities:
//   1. On load / resize / every page change, report `{ index, total, w, h }`
//      where `w`/`h` are the active slide's box. The load-path report is
//      deferred across animation frames until the slide has a non-zero box:
//      measuring synchronously at `load` can read 0x0 before the deck's own
//      layout settles, and a 0x0 report leaves the stage stuck at
//      `data-viewer-state="loading"` with no fit until a nav key or resize.
//   2. Apply page changes commanded by the stage as `VIEWER_GOTO_PAGE_MESSAGE`.
const VIEWER_PAGING_CONTROLLER = `<script>(function(){var SEL='${VIEWER_SLIDE_SELECTOR}';var apply=${applyViewerPage.toString()};function slides(){return Array.prototype.slice.call(document.querySelectorAll(SEL))}var current=0;function box(el){var r=el.getBoundingClientRect();return{w:r.width||el.scrollWidth,h:r.height||el.scrollHeight}}function post(w,h,total){try{parent.postMessage({type:'${VIEWER_PAGE_MESSAGE}',index:current,total:total,w:w,h:h},'*')}catch(e){}}function report(){var all=slides();if(!all.length)return;var b=box(all[current]||all[0]);post(b.w,b.h,all.length)}function settle(frames){var all=slides();var el=all[current]||all[0];if(!el)return;var b=box(el);if((b.w>0&&b.h>0)||frames<=0){post(b.w,b.h,all.length);return}requestAnimationFrame(function(){settle(frames-1)})}function go(i){current=apply(slides(),i);settle(12)}window.addEventListener('message',function(e){if(!e.data||e.data.type!=='${VIEWER_GOTO_PAGE_MESSAGE}')return;go(e.data.page|0)});if(document.readyState==='complete')go(0);else window.addEventListener('load',function(){go(0)});window.addEventListener('resize',report)})();</script>`

// Viewer-shell variant of `prepareMiniAppHtml`: same CSP + data-slot
// bootstrap, plus the doc-size + wheel-forwarding reporter so the stage can
// compute fit-to-screen and drive its own zoom/scroll from gestures that
// land over the document. Pass `{ paged: true }` for a doc that resolved to
// deck render mode to additionally inject the paging controller. Both scripts
// ride the same fragment, so this stays a single `injectIntoHtml` call — see
// the header comment on `injectIntoHtml` above.
export function prepareViewerHtml(html: string, options?: { paged?: boolean }): string {
	const scrubbed = stripMetaRefresh(stripAgentCsp(html))
	const paging = options?.paged ? VIEWER_PAGING_CONTROLLER : ''
	return injectIntoHtml(scrubbed, CSP_META + DATA_SLOT_BOOTSTRAP + VIEWER_REPORTER + paging)
}
