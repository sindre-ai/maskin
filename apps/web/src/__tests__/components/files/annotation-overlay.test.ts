// @vitest-environment node
import { injectScript } from '@/components/files/annotation-overlay'
import { prepareMiniAppHtml } from '@/lib/mini-app'
import { describe, expect, it } from 'vitest'

describe('injectScript', () => {
	it('inserts after <head> when present', () => {
		const html = '<html><head></head><body></body></html>'
		const result = injectScript(html)
		expect(result.indexOf('<head>') + 6).toBe(result.indexOf('<script>'))
	})

	it('inserts after <!DOCTYPE html> when no <head>', () => {
		const html = '<!DOCTYPE html><html><body>hello</body></html>'
		const result = injectScript(html)
		// Script must come after the closing > of DOCTYPE, not before it
		expect(result.startsWith('<!DOCTYPE html>')).toBe(true)
		expect(result.indexOf('<!DOCTYPE html>') + '<!DOCTYPE html>'.length).toBe(
			result.indexOf('<script>'),
		)
	})

	it('handles lowercase <!doctype html>', () => {
		const html = '<!doctype html><html><body>hi</body></html>'
		const result = injectScript(html)
		expect(result.startsWith('<!doctype html>')).toBe(true)
	})

	it('inserts before <body> when no <head> and no doctype', () => {
		const html = '<html><body>content</body></html>'
		const result = injectScript(html)
		const bodyIdx = result.indexOf('<body>')
		const scriptIdx = result.indexOf('<script>')
		expect(scriptIdx).toBeLessThan(bodyIdx)
	})

	it('prepends as last resort when no <head>, doctype, or <body>', () => {
		const html = '<p>bare fragment</p>'
		const result = injectScript(html)
		expect(result.startsWith('<script>')).toBe(true)
	})
})

describe('annotate iframe srcdoc seam', () => {
	it('carries the platform CSP and data-slot bootstrap around the listener script', () => {
		const html = '<html><head></head><body>hi</body></html>'
		// Matches the component's injectedHtml pipeline (annotation-overlay.tsx):
		// listener script first, then the platform footer is applied last.
		const srcdoc = prepareMiniAppHtml(injectScript(html))
		expect(srcdoc).toContain("connect-src 'none'")
		expect(srcdoc).toContain('__MASKIN_APP_DATA__')
		expect(srcdoc).toContain('MASKIN_GET_ELEMENT')
		// The platform CSP meta lands immediately after the real <head> open tag,
		// before the agent script — so the listener runs under the platform policy.
		expect(srcdoc.indexOf('<meta')).toBe(srcdoc.indexOf('<head>') + 6)
	})
})
