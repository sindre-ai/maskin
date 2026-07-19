import { describe, expect, it } from 'vitest'
import { renderMarkdownToHtml } from '../render'

describe('renderMarkdownToHtml', () => {
	it('renders basic markdown to sanitised HTML', () => {
		const html = renderMarkdownToHtml('# Hello\n\nThis is **bold**.')
		expect(html).toContain('<h1>Hello</h1>')
		expect(html).toContain('<strong>bold</strong>')
	})

	it('renders GFM tables', () => {
		const html = renderMarkdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |')
		expect(html).toContain('<table>')
		expect(html).toContain('<th>a</th>')
		expect(html).toContain('<td>1</td>')
	})

	it('strips raw <script> tags', () => {
		const html = renderMarkdownToHtml('<script>alert(1)</script>\n\nhello')
		expect(html).not.toContain('<script>')
		expect(html).not.toContain('alert(1)')
		expect(html).toContain('hello')
	})

	it('strips inline style attributes', () => {
		const html = renderMarkdownToHtml('<p style="color:red">x</p>')
		expect(html).not.toContain('style=')
	})

	it('adds rel + target on external links', () => {
		const html = renderMarkdownToHtml('[go](https://example.com)')
		expect(html).toContain('href="https://example.com"')
		expect(html).toContain('target="_blank"')
		expect(html).toContain('rel="noopener noreferrer"')
	})

	it('leaves internal (root-relative) links alone', () => {
		const html = renderMarkdownToHtml('[home](/method/development)')
		expect(html).toContain('href="/method/development"')
		expect(html).not.toContain('target="_blank"')
	})

	it('strips javascript: URLs', () => {
		const html = renderMarkdownToHtml('[go](javascript:alert(1))')
		expect(html).not.toContain('javascript:')
	})
})
