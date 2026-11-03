import {
	DATA_SLOT_ID,
	MINI_APP_CSP,
	VIEWER_DOC_SIZE_MESSAGE,
	VIEWER_GOTO_PAGE_MESSAGE,
	VIEWER_PAGE_MESSAGE,
	VIEWER_SLIDE_SELECTOR,
	VIEWER_WHEEL_MESSAGE,
	applyViewerPage,
	collectViewerSlides,
	injectIntoHtml,
	prepareMiniAppHtml,
	prepareViewerHtml,
	showViewerPage,
	stripAgentCsp,
	stripMetaRefresh,
} from '@/lib/mini-app'
import { describe, expect, it } from 'vitest'

// Extracts the data-slot bootstrap <script> body from a prepared document so
// the getter can be evaluated against a live jsdom document (jsdom does not
// execute srcdoc frame scripts, but the contract itself runs here).
function extractBootstrap(html: string): string {
	const match = html.match(/<script>(Object\.defineProperty[\s\S]*?)<\/script>/)
	return match?.[1] ?? ''
}

// The bootstrap defines a configurable accessor with no setter, so assignment
// cannot remove it — Reflect.deleteProperty is the only clean teardown.
function removeAppDataGlobal(): void {
	Reflect.deleteProperty(window, '__MASKIN_APP_DATA__')
}

describe('injectIntoHtml', () => {
	it('inserts after <head> when present', () => {
		const html = '<html><head></head><body></body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result.indexOf('<head>') + 6).toBe(result.indexOf('FRAG'))
	})

	it('inserts after the doctype closing > so FRAG never precedes <!DOCTYPE>', () => {
		const html = '<!DOCTYPE html><html><body>hello</body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result.startsWith('<!DOCTYPE html>')).toBe(true)
		expect(result).toBe('<!DOCTYPE html>FRAG<html><body>hello</body></html>')
	})

	it('handles lowercase <!doctype html>', () => {
		const html = '<!doctype html><html><body>hi</body></html>'
		expect(injectIntoHtml(html, 'FRAG').startsWith('<!doctype html>FRAG')).toBe(true)
	})

	it('inserts before <body> when no <head> and no doctype', () => {
		const html = '<html><body>content</body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result.indexOf('FRAG')).toBeLessThan(result.indexOf('<body>'))
	})

	it('prepends as last resort when no <head>, doctype, or <body>', () => {
		expect(injectIntoHtml('<p>bare fragment</p>', 'FRAG').startsWith('FRAG')).toBe(true)
	})

	it('ignores a <head>-shaped token inside a script string', () => {
		const html = '<html><head><script>const s = "<head>";</script></head><body></body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		// Naive indexOf would place FRAG inside the script string; the real
		// head is the first <head> open tag, outside raw-text content.
		expect(result.indexOf('FRAG')).toBe(result.indexOf('<head>') + 6)
		expect(result.indexOf('FRAG')).toBeLessThan(result.indexOf('<script>'))
	})

	it('ignores a <head>-shaped token inside a pre/code block', () => {
		const html = '<html><pre><head></pre><head></head><body></body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result).toContain('<pre><head></pre><head>FRAG</head>')
	})

	it('ignores a <head>-shaped token inside a textarea', () => {
		const html = '<html><textarea><head></textarea><head></head><body></body></html>'
		expect(injectIntoHtml(html, 'FRAG')).toContain('<textarea><head></textarea><head>FRAG')
	})

	it('inserts after a <head> that carries attributes', () => {
		const html = '<html><head lang="en" data-x="1"></head><body></body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result.startsWith('<html><head lang="en" data-x="1">FRAG')).toBe(true)
	})

	it('inserts after an uppercase <HEAD>', () => {
		const html = '<HTML><HEAD><BODY>x</BODY></HTML>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result.indexOf('FRAG')).toBe(result.indexOf('<HEAD>') + 6)
	})

	it('does not treat a > inside a quoted attribute value as the end of the head tag', () => {
		const html = '<html><head data-t="a>b" class="x"></head><body></body></html>'
		const result = injectIntoHtml(html, 'FRAG')
		expect(result.startsWith('<html><head data-t="a>b" class="x">FRAG')).toBe(true)
	})

	it('ignores a <head> inside an HTML comment', () => {
		const html = '<html><!-- <head> --><head></head><body></body></html>'
		expect(injectIntoHtml(html, 'FRAG')).toContain('<!-- <head> --><head>FRAG')
	})
})

describe('stripAgentCsp', () => {
	it('removes an agent CSP meta with a lowercase http-equiv', () => {
		const html =
			'<html><head><meta http-equiv="content-security-policy" content="script-src https://evil.example"></head></html>'
		expect(stripAgentCsp(html)).not.toContain('evil.example')
	})

	it('removes an agent CSP meta with uppercase/mixed-case http-equiv', () => {
		const html =
			'<meta HTTP-EQUIV="Content-Security-Policy" content="default-src \'self\'"><html></html>'
		expect(stripAgentCsp(html)).toBe('<html></html>')
	})

	it('removes an agent CSP meta with an unquoted http-equiv', () => {
		const html =
			'<meta http-equiv=content-security-policy content="default-src \'self\'"><html></html>'
		expect(stripAgentCsp(html)).toBe('<html></html>')
	})

	it('leaves non-CSP metas untouched', () => {
		const html = '<meta charset="utf-8"><meta name="description" content="hi"><html></html>'
		expect(stripAgentCsp(html)).toBe(html)
	})
})

describe('stripMetaRefresh', () => {
	it('removes a refresh meta that would silently navigate the frame', () => {
		const html =
			'<html><head><meta http-equiv="refresh" content="0; url=https://evil.example"></head></html>'
		const result = stripMetaRefresh(html)
		expect(result).not.toContain('refresh')
		expect(result).not.toContain('evil.example')
	})

	it('leaves non-refresh metas untouched', () => {
		const html =
			'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><meta charset="utf-8">'
		expect(stripMetaRefresh(html)).toBe(html)
	})

	it('prepareMiniAppHtml strips refresh metas alongside agent CSP metas', () => {
		const html =
			'<html><head><meta http-equiv="refresh" content="0; url=https://evil.example"></head><body>hi</body></html>'
		const prepared = prepareMiniAppHtml(html)
		expect(prepared).not.toContain('refresh')
		expect(prepared).toContain("connect-src 'none'")
	})
})

describe('prepareMiniAppHtml', () => {
	it('injects the full platform CSP meta', () => {
		const prepared = prepareMiniAppHtml('<html><head></head><body></body></html>')
		for (const directive of [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			"script-src 'unsafe-inline'",
			'img-src data:',
			"connect-src 'none'",
			"form-action 'none'",
			"base-uri 'none'",
		]) {
			expect(prepared).toContain(directive)
		}
	})

	it('exports exactly the directives the architecture decision fixed', () => {
		expect(MINI_APP_CSP).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
		)
	})

	it('strips any agent CSP meta so only the platform policy holds', () => {
		const html =
			'<html><head><meta http-equiv="Content-Security-Policy" content="script-src https://evil.example"></head><body>hi</body></html>'
		const prepared = prepareMiniAppHtml(html)
		expect(prepared).not.toContain('evil.example')
		expect(prepared).toContain("connect-src 'none'")
	})

	it('injects the data-slot bootstrap naming the declared slot and global', () => {
		const prepared = prepareMiniAppHtml('<html><body>hi</body></html>')
		expect(prepared).toContain('__MASKIN_APP_DATA__')
		expect(prepared).toContain(`'${DATA_SLOT_ID}'`)
	})

	it('keeps the original document content intact', () => {
		const html = '<html><body><h1>Hello</h1></body></html>'
		const prepared = prepareMiniAppHtml(html)
		expect(prepared).toContain('<h1>Hello</h1>')
	})
})

describe('data-slot contract', () => {
	it('exposes the slot JSON as window.__MASKIN_APP_DATA__ via a lazy getter', () => {
		const slot = document.createElement('script')
		slot.id = DATA_SLOT_ID
		slot.type = 'application/json'
		slot.textContent = JSON.stringify({ title: 'Bet', score: 42 })
		document.body.appendChild(slot)

		const prepared = prepareMiniAppHtml('<html><body>hi</body></html>')
		const bootstrap = extractBootstrap(prepared)
		expect(bootstrap).not.toBe('')

		// Evaluate the getter definition against the live document. The getter
		// reads the slot on every access, so the document must not be torn down
		// between define and read.
		const define = new Function(bootstrap)
		define.call(window)

		expect((window as unknown as { __MASKIN_APP_DATA__: unknown }).__MASKIN_APP_DATA__).toEqual({
			title: 'Bet',
			score: 42,
		})

		removeAppDataGlobal()
		slot.remove()
	})

	it('yields null when the slot is missing', () => {
		const prepared = prepareMiniAppHtml('<html><body>hi</body></html>')
		const define = new Function(extractBootstrap(prepared))
		define.call(window)

		expect((window as unknown as { __MASKIN_APP_DATA__: unknown }).__MASKIN_APP_DATA__).toBeNull()

		removeAppDataGlobal()
	})

	it('yields null when the slot contains invalid JSON', () => {
		const slot = document.createElement('script')
		slot.id = DATA_SLOT_ID
		slot.type = 'application/json'
		slot.textContent = '{not json'
		document.body.appendChild(slot)

		const prepared = prepareMiniAppHtml('<html><body>hi</body></html>')
		const define = new Function(extractBootstrap(prepared))
		define.call(window)

		expect((window as unknown as { __MASKIN_APP_DATA__: unknown }).__MASKIN_APP_DATA__).toBeNull()

		removeAppDataGlobal()
		slot.remove()
	})

	it('re-reads the slot on every access (timing-independent)', () => {
		const slot = document.createElement('script')
		slot.id = DATA_SLOT_ID
		slot.type = 'application/json'
		slot.textContent = JSON.stringify({ v: 1 })
		document.body.appendChild(slot)

		const define = new Function(extractBootstrap(prepareMiniAppHtml('<html></html>')))
		define.call(window)

		expect((window as unknown as { __MASKIN_APP_DATA__: unknown }).__MASKIN_APP_DATA__).toEqual({
			v: 1,
		})

		// Mutating the slot after definition must be reflected — the getter
		// reads the node lazily rather than snapshotting at define time.
		slot.textContent = JSON.stringify({ v: 2 })
		expect((window as unknown as { __MASKIN_APP_DATA__: unknown }).__MASKIN_APP_DATA__).toEqual({
			v: 2,
		})

		removeAppDataGlobal()
		slot.remove()
	})
})

describe('prepareViewerHtml', () => {
	it('injects the platform CSP + data-slot bootstrap + reporter in ONE injection', () => {
		const html = '<!DOCTYPE html><html><head></head><body>hi</body></html>'
		const result = prepareViewerHtml(html)
		expect(result).toContain(MINI_APP_CSP)
		expect(result).toContain(DATA_SLOT_ID)
		expect(result).toContain(VIEWER_DOC_SIZE_MESSAGE)
		expect(result).toContain(VIEWER_WHEEL_MESSAGE)
		// One contiguous injection point: the CSP meta, the bootstrap script,
		// and the reporter script all sit immediately after <head>.
		const headEnd = result.indexOf('<head>') + '<head>'.length
		const cspIdx = result.indexOf('<meta http-equiv="Content-Security-Policy"')
		expect(cspIdx).toBe(headEnd)
	})

	it('strips agent CSP metas before stamping the platform policy', () => {
		const html =
			'<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>'
		const result = prepareViewerHtml(html)
		expect(result).not.toContain('default-src *')
		expect(result).toContain(MINI_APP_CSP)
	})

	it('doc-size reporter posts a message on load using the shared type name', () => {
		const html = '<!DOCTYPE html><html><body></body></html>'
		const result = prepareViewerHtml(html)
		// The reporter script uses parent.postMessage with our exact type token
		// so the stage's listener can filter cross-frame chatter deterministically.
		expect(result).toMatch(
			new RegExp(`parent\\.postMessage\\(\\{type:'${VIEWER_DOC_SIZE_MESSAGE}'`),
		)
	})

	it('wheel-forwarding reporter posts every wheel to the parent with delta + ctrl + doc-space cursor', () => {
		const html = '<!DOCTYPE html><html><body></body></html>'
		const result = prepareViewerHtml(html)
		// Sandboxed frames swallow their own wheel events (they fire in the
		// frame's browsing context and never bubble to the parent listener),
		// so ctrl+wheel zoom over the document depends on this forwarding path.
		expect(result).toMatch(new RegExp(`parent\\.postMessage\\(\\{type:'${VIEWER_WHEEL_MESSAGE}'`))
		expect(result).toContain('deltaX:e.deltaX')
		expect(result).toContain('deltaY:e.deltaY')
		expect(result).toContain('ctrlKey:e.ctrlKey')
		expect(result).toContain('docX:e.clientX')
		expect(result).toContain('docY:e.clientY')
		// passive:false is what lets the reporter's preventDefault suppress the
		// browser's Ctrl+wheel page zoom inside the frame — a passive listener
		// cannot preventDefault, so a page zoom would race the stage zoom.
		expect(result).toContain('{passive:false}')
	})

	it('keeps the original document content intact', () => {
		const html = '<!DOCTYPE html><html><body><p>hello</p></body></html>'
		expect(prepareViewerHtml(html)).toContain('<p>hello</p>')
	})
})

describe('viewer paging controller', () => {
	function buildSlides(count: number): { root: HTMLElement; slides: HTMLElement[] } {
		const root = document.createElement('div')
		for (let i = 0; i < count; i++) {
			const slide = document.createElement('section')
			slide.setAttribute('data-slide', String(i))
			root.appendChild(slide)
		}
		return { root, slides: Array.from(root.querySelectorAll<HTMLElement>('[data-slide]')) }
	}

	it('shows exactly one slide and hides the rest', () => {
		const { root, slides } = buildSlides(3)
		showViewerPage(root, 1)
		expect(slides.map((slide) => slide.style.display)).toEqual(['none', '', 'none'])
		// a second navigation moves the visible slide rather than adding one
		showViewerPage(root, 2)
		expect(slides.map((slide) => slide.style.display)).toEqual(['none', 'none', ''])
	})

	it('clamps an out-of-range page index into the slide set', () => {
		const { root } = buildSlides(3)
		expect(showViewerPage(root, 99)).toBe(2)
		expect(applyViewerPage(collectViewerSlides(root), -5)).toBe(0)
	})

	it('collects every documented slide shape and ignores everything else', () => {
		const root = document.createElement('div')
		root.innerHTML =
			'<div data-slide></div><section class="slide"></section><div id="slide-3"></div><p>not a slide</p>'
		expect(collectViewerSlides(root)).toHaveLength(3)
	})

	it('injects the paging controller only for a paged document', () => {
		const html = '<!DOCTYPE html><html><head></head><body></body></html>'
		const paged = prepareViewerHtml(html, { paged: true })
		const single = prepareViewerHtml(html)
		// the goto handler matches with !== while the reporter posts with type:'…'
		expect(paged).toContain(`!=='${VIEWER_GOTO_PAGE_MESSAGE}'`)
		expect(paged).toContain(`type:'${VIEWER_PAGE_MESSAGE}'`)
		expect(single).not.toContain(VIEWER_GOTO_PAGE_MESSAGE)
		expect(single).not.toContain(VIEWER_PAGE_MESSAGE)
	})

	it('shares one injection between the paging controller and the doc-size reporter', () => {
		const html = '<!DOCTYPE html><html><head></head><body></body></html>'
		const paged = prepareViewerHtml(html, { paged: true })
		// Slice 1's reporter must survive into the paged document on the same
		// single injectIntoHtml call — a second injection would duplicate the CSP.
		expect(paged).toContain(VIEWER_DOC_SIZE_MESSAGE)
		expect(paged.match(/<meta http-equiv="Content-Security-Policy"/g)).toHaveLength(1)
	})

	it('embeds the same selector and page function the unit tests exercise', () => {
		const paged = prepareViewerHtml('<!DOCTYPE html><html><body></body></html>', {
			paged: true,
		})
		// The injected controller interpolates the selector constant and embeds
		// applyViewerPage via toString(), so it cannot drift from the tested one.
		expect(paged).toContain(`var SEL='${VIEWER_SLIDE_SELECTOR}'`)
		expect(paged).toContain(applyViewerPage.toString())
	})

	it('measures the active slide box and defers the load-path report past layout', () => {
		const paged = prepareViewerHtml('<!DOCTYPE html><html><body></body></html>', {
			paged: true,
		})
		// jsdom cannot execute the srcdoc frame script, so this pins the two
		// runtime properties AC3 depends on: the box comes from the rendered
		// rect (not a synchronous scrollWidth read at `load`), and the initial
		// report is retried across frames until the slide has a non-zero box.
		expect(paged).toContain('getBoundingClientRect')
		expect(paged).toContain('requestAnimationFrame')
	})
})
