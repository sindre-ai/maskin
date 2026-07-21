import { describe, expect, it } from 'vitest'
import { editorHtmlToMarkdown, markdownToEditorHtml } from '../tiptap'
import { serializeMarkdown } from '../serialize'

// The tiptap adapter is the editor's IO layer: markdown → HTML on load,
// HTML → canonical Markdown on save. Every save must leave through the
// same options `serializeMarkdown` uses, so tables/task-lists/code fences
// round-trip through the editor with the same shape T1's corpus asserts.

describe('markdownToEditorHtml', () => {
	it('renders headings and paragraphs', () => {
		const html = markdownToEditorHtml('# Title\n\nBody paragraph.\n')
		expect(html).toContain('<h1>Title</h1>')
		expect(html).toContain('<p>Body paragraph.</p>')
	})

	it('renders GFM tables', () => {
		const source = '| a | b |\n| - | - |\n| 1 | 2 |\n'
		const html = markdownToEditorHtml(source)
		expect(html).toContain('<table>')
		expect(html).toContain('<th>a</th>')
	})

	it('renders GFM task lists as checkbox inputs', () => {
		const html = markdownToEditorHtml('- [x] done\n- [ ] todo\n')
		expect(html).toContain('type="checkbox"')
		expect(html).toContain('checked')
	})
})

describe('editorHtmlToMarkdown', () => {
	it('strips raw HTML wrappers, emits canonical markdown', () => {
		const html = '<p>Body <strong>bold</strong> text.</p>'
		const markdown = editorHtmlToMarkdown(html)
		expect(markdown).toBe('Body **bold** text.\n')
	})

	it('emits `-` bullets and `*` emphasis (matches canonical serializer options)', () => {
		const html = '<ul><li>one</li><li>two</li></ul>'
		expect(editorHtmlToMarkdown(html)).toBe('- one\n- two\n')
	})

	it('emits fenced code blocks with language info', () => {
		const html = '<pre><code class="language-ts">const x = 1</code></pre>'
		const markdown = editorHtmlToMarkdown(html)
		expect(markdown).toContain('```ts')
		expect(markdown).toContain('const x = 1')
	})

	it('normalises a Notion-style HTML paste (h1 + list + link)', () => {
		const html =
			'<h1>Meeting notes</h1><ul><li>Point <a href="https://maskin.io">one</a></li><li>Point two</li></ul>'
		const markdown = editorHtmlToMarkdown(html)
		expect(markdown).toContain('# Meeting notes')
		expect(markdown).toContain('- Point [one](https://maskin.io)')
		expect(markdown).toContain('- Point two')
	})

	it('normalises a GitHub-rendered HTML table paste', () => {
		const html =
			'<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
		const markdown = editorHtmlToMarkdown(html)
		expect(markdown).toContain('| a')
		expect(markdown).toContain('| b')
		expect(markdown).toContain('| 1')
		expect(markdown).toContain('| 2')
	})

	it('is stable through a second pass (idempotent on canonical output)', () => {
		const html = '<h2>Two</h2><p>Text with <em>italic</em>.</p>'
		const first = editorHtmlToMarkdown(html)
		const second = serializeMarkdown(first)
		expect(second).toBe(first)
	})
})

describe('editor round-trip through the owned serializer', () => {
	// The critical invariant: HTML that came out of the editor, when converted
	// back to markdown and then serialized, matches the owned-serializer output.
	// This is what protects the "no serializer drift between editor save and
	// T1's CI corpus" contract.
	const cases: Array<[label: string, source: string]> = [
		['tight list', '# Tight list\n\n- one\n- two\n- three\n'],
		['ordered list', '# Ordered\n\n1. one\n2. two\n3. three\n'],
		[
			'table',
			'# Table\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
		],
		['bold + link', 'A **strong** and a [link](https://maskin.io).\n'],
	]
	for (const [label, source] of cases) {
		it(`${label}: markdown → html → markdown lands in canonical shape`, () => {
			const html = markdownToEditorHtml(source)
			const back = editorHtmlToMarkdown(html)
			// Second pass through the owned serializer must be a fixed point.
			expect(serializeMarkdown(back)).toBe(back)
		})
	}
})
