import {
	DATA_SLOT_ID,
	MINI_APP_CSP,
	injectIntoHtml,
	prepareMiniAppHtml,
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
