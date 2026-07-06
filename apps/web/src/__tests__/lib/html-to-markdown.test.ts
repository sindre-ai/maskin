import { ZERO_WIDTH_SPACE, htmlToMarkdown } from '@/lib/html-to-markdown'
import { describe, expect, it } from 'vitest'

describe('htmlToMarkdown', () => {
	it('converts bold text', () => {
		expect(htmlToMarkdown('<p><strong>bold text</strong></p>')).toBe('**bold text**')
	})

	it('converts headings', () => {
		expect(htmlToMarkdown('<h2>Heading</h2>')).toBe('## Heading')
	})

	it('converts unordered lists', () => {
		expect(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('*   one\n*   two')
	})

	it('converts links', () => {
		expect(htmlToMarkdown('<a href="https://example.com">example</a>')).toBe(
			'[example](https://example.com)',
		)
	})

	it('converts a single <br> to a single newline instead of a two-space hardbreak', () => {
		expect(htmlToMarkdown('<p>line one<br>line two</p>')).toBe('line one\nline two')
	})

	it('converts multiple consecutive <br> tags to matching newlines', () => {
		expect(htmlToMarkdown('<p>one<br><br>two</p>')).toBe('one\n\ntwo')
	})

	it('converts GFM strikethrough', () => {
		// turndown-plugin-gfm emits a single tilde; remark-gfm's default
		// `singleTilde: true` still parses it as strikethrough, so this round-trips.
		expect(htmlToMarkdown('<del>gone</del>')).toBe('~gone~')
	})

	it('converts GFM tables', () => {
		const html =
			'<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain('| A | B |')
		expect(markdown).toContain('| 1 | 2 |')
	})

	it('is a singleton that produces consistent output across repeated calls', () => {
		const first = htmlToMarkdown('<p><em>hi</em></p>')
		const second = htmlToMarkdown('<p><em>hi</em></p>')
		expect(first).toBe(second)
	})

	it('strips the zero-width-space caret anchor left behind by a live block conversion', () => {
		// markdown-input-rules.ts seeds a freshly-converted empty heading/list/
		// blockquote with a zero-width space so Chrome gives it a real caret to
		// type into; it must never leak into saved markdown.
		expect(htmlToMarkdown(`<h1>${ZERO_WIDTH_SPACE}Heading</h1>`)).toBe('# Heading')
		expect(htmlToMarkdown(`<h1>${ZERO_WIDTH_SPACE}</h1>`)).not.toContain(ZERO_WIDTH_SPACE)
	})
})
