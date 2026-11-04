// Comments on selected text: the anchor a selection produces, the matcher that
// finds it again, and the highlight layer that draws it. The highlights are
// decorations only, so the markdown that would be saved must not change.

import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import {
	type CommentHighlightHandlers,
	type TextCommentHighlight,
	createCommentHighlights,
	setTextComments,
	textCommentRange,
} from '../comment-highlights'
import { buildExtensions } from '../extensions'
import {
	MAX_ANCHOR_QUOTE,
	type TextAnchor,
	captureTextAnchor,
	findAnchorRange,
	isCommentableSelection,
	renderedText,
} from '../text-anchor'
import { openSource } from './open-source'

const DOC = [
	'# Title of the file',
	'',
	'The quick brown fox jumps over the lazy dog.',
	'',
	'- first item in a list',
	'- second item in a list',
	'',
	'```js',
	'const answer = 42',
	'```',
	'',
	'| a | b |',
	'| - | - |',
	'| cell one | cell two |',
	'',
	'Another paragraph: the quick brown fox again.',
	'',
].join('\n')

/** The document range of the nth occurrence of a piece of rendered text. */
function rangeOf(editor: Editor, text: string, nth = 0): { from: number; to: number } {
	const rendered = renderedText(editor.state.doc)
	let index = -1
	for (let i = 0; i <= nth; i++) index = rendered.text.indexOf(text, index + 1)
	if (index === -1) throw new Error(`no ${text} in the document`)
	return {
		from: rendered.positions[index] as number,
		to: (rendered.positions[index + text.length - 1] as number) + 1,
	}
}

describe('captureTextAnchor', () => {
	it('captures the quote with about 24 characters of context either side', () => {
		const { editor, destroy } = openSource(DOC)
		const { from, to } = rangeOf(editor, 'brown fox')
		const anchor = captureTextAnchor(editor.state.doc, from, to)
		expect(anchor).toEqual({
			quote: 'brown fox',
			prefix: 'e of the file\nThe quick ',
			suffix: ' jumps over the lazy dog',
		})
		expect(anchor?.prefix.length).toBeLessThanOrEqual(24)
		expect(anchor?.suffix.length).toBeLessThanOrEqual(24)
		destroy()
	})

	it('carries a block boundary as a line break in the context', () => {
		const { editor, destroy } = openSource(DOC)
		const { from, to } = rangeOf(editor, 'Title')
		expect(captureTextAnchor(editor.state.doc, from, to)?.prefix).toBe('')
		const second = rangeOf(editor, 'The quick')
		expect(captureTextAnchor(editor.state.doc, second.from, second.to)?.prefix).toBe(
			'Title of the file\n',
		)
		destroy()
	})

	it('caps the quote at 500 characters', () => {
		const long = 'word '.repeat(200).trim()
		const { editor, destroy } = openSource(`${long}\n`)
		const anchor = captureTextAnchor(editor.state.doc, 1, editor.state.doc.content.size - 1)
		expect(anchor?.quote.length).toBe(MAX_ANCHOR_QUOTE)
		destroy()
	})

	it('allows a heading and a paragraph', () => {
		const { editor, destroy } = openSource(DOC)
		const heading = rangeOf(editor, 'Title of')
		const paragraph = rangeOf(editor, 'lazy dog')
		expect(isCommentableSelection(editor.state.doc, heading.from, heading.to)).toBe(true)
		expect(isCommentableSelection(editor.state.doc, paragraph.from, paragraph.to)).toBe(true)
		destroy()
	})

	it.each([
		['a list item', 'second item'],
		['a code block', 'const answer'],
		['a table cell', 'cell one'],
	])('refuses a selection inside %s', (_name, text) => {
		const { editor, destroy } = openSource(DOC)
		const { from, to } = rangeOf(editor, text)
		expect(isCommentableSelection(editor.state.doc, from, to)).toBe(false)
		expect(captureTextAnchor(editor.state.doc, from, to)).toBeNull()
		destroy()
	})

	it('refuses a selection that spans two blocks', () => {
		const { editor, destroy } = openSource(DOC)
		const start = rangeOf(editor, 'lazy dog')
		const end = rangeOf(editor, 'Another')
		expect(isCommentableSelection(editor.state.doc, start.from, end.to)).toBe(false)
		destroy()
	})

	it('refuses an empty or whitespace-only selection', () => {
		const { editor, destroy } = openSource('one two\n')
		expect(isCommentableSelection(editor.state.doc, 2, 2)).toBe(false)
		expect(isCommentableSelection(editor.state.doc, 4, 5)).toBe(false)
		destroy()
	})
})

describe('findAnchorRange', () => {
	it('finds the quote again in the rendered text', () => {
		const { editor, destroy } = openSource(DOC)
		const { from, to } = rangeOf(editor, 'lazy dog')
		const anchor = captureTextAnchor(editor.state.doc, from, to) as TextAnchor
		expect(findAnchorRange(renderedText(editor.state.doc), anchor)).toEqual({ from, to })
		destroy()
	})

	it('picks the right one of two identical quotes by prefix and suffix', () => {
		const { editor, destroy } = openSource(DOC)
		const second = rangeOf(editor, 'quick brown fox', 1)
		const anchor = captureTextAnchor(editor.state.doc, second.from, second.to) as TextAnchor
		expect(findAnchorRange(renderedText(editor.state.doc), anchor)).toEqual(second)
		const first = rangeOf(editor, 'quick brown fox', 0)
		const firstAnchor = captureTextAnchor(editor.state.doc, first.from, first.to) as TextAnchor
		expect(findAnchorRange(renderedText(editor.state.doc), firstAnchor)).toEqual(first)
		destroy()
	})

	it('returns null once the quote is gone', () => {
		const { editor, destroy } = openSource(DOC)
		const { from, to } = rangeOf(editor, 'lazy dog')
		const anchor = captureTextAnchor(editor.state.doc, from, to) as TextAnchor
		editor.commands.insertContentAt({ from, to }, 'sleepy cat')
		expect(findAnchorRange(renderedText(editor.state.doc), anchor)).toBeNull()
		destroy()
	})

	it('still finds the quote after an unrelated edit elsewhere', () => {
		const { editor, destroy } = openSource(DOC)
		const { from, to } = rangeOf(editor, 'lazy dog')
		const anchor = captureTextAnchor(editor.state.doc, from, to) as TextAnchor
		const title = rangeOf(editor, 'Title')
		editor.commands.insertContentAt({ from: title.from, to: title.to }, 'Name')
		const range = findAnchorRange(renderedText(editor.state.doc), anchor)
		expect(range).not.toBeNull()
		expect(editor.state.doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe('lazy dog')
		destroy()
	})
})

function withHighlights(markdown: string) {
	const calls: { orphaned: string[][]; clicked: string[] } = { orphaned: [], clicked: [] }
	const handlers: { current: CommentHighlightHandlers } = {
		current: {
			onOrphansChange: (ids) => calls.orphaned.push(ids),
			onHighlightClick: (id) => calls.clicked.push(id),
			describedBy: (id) => `card-${id}`,
		},
	}
	const editor = new Editor({
		extensions: buildExtensions('document', undefined, undefined, [
			createCommentHighlights(handlers),
		]),
		content: markdown,
	})
	return { editor, calls, destroy: () => editor.destroy() }
}

function anchorFor(editor: Editor, text: string, nth = 0): TextAnchor {
	const { from, to } = rangeOf(editor, text, nth)
	return captureTextAnchor(editor.state.doc, from, to) as TextAnchor
}

describe('comment highlights', () => {
	it('draws a decoration with the comment id and a pointer to its card', () => {
		const { editor, destroy } = withHighlights(DOC)
		const comments: TextCommentHighlight[] = [{ id: 'c1', anchor: anchorFor(editor, 'lazy dog') }]
		setTextComments(editor.view, comments, null)
		const span = editor.view.dom.querySelector('[data-comment-id="c1"]')
		expect(span?.textContent).toBe('lazy dog')
		expect(span?.getAttribute('aria-describedby')).toBe('card-c1')
		expect(span?.classList.contains('maskin-comment-highlight')).toBe(true)
		destroy()
	})

	it('marks the active highlight and drops the background of a resolved one', () => {
		const { editor, destroy } = withHighlights(DOC)
		setTextComments(
			editor.view,
			[
				{ id: 'c1', anchor: anchorFor(editor, 'lazy dog') },
				{ id: 'c2', anchor: anchorFor(editor, 'Title'), resolved: true },
			],
			'c1',
		)
		expect(
			editor.view.dom
				.querySelector('[data-comment-id="c1"]')
				?.classList.contains('maskin-comment-highlight--active'),
		).toBe(true)
		expect(
			editor.view.dom
				.querySelector('[data-comment-id="c2"]')
				?.classList.contains('maskin-comment-highlight--resolved'),
		).toBe(true)
		destroy()
	})

	it('leaves the markdown that would be saved byte for byte the same', () => {
		const opened = openSource(DOC)
		const before = opened.save().text
		const handlers = { current: {} }
		const withLayer = new Editor({
			extensions: buildExtensions('document', undefined, undefined, [
				createCommentHighlights(handlers),
			]),
			content: DOC,
		})
		const plain = withLayer.storage.markdown.getMarkdown() as string
		setTextComments(
			withLayer.view,
			[
				{ id: 'c1', anchor: anchorFor(withLayer, 'lazy dog') },
				{ id: 'c2', anchor: anchorFor(withLayer, 'Title'), resolved: true },
				{ id: 'c3', anchor: { quote: 'gone', prefix: '', suffix: '' } },
			],
			'c1',
		)
		expect(withLayer.storage.markdown.getMarkdown()).toBe(plain)
		expect(before).toBe(DOC)
		expect(withLayer.getHTML()).not.toContain('data-comment-id')
		withLayer.destroy()
		opened.destroy()
	})

	it('reports a comment whose quote is gone as orphaned, and draws nothing for it', async () => {
		const { editor, calls, destroy } = withHighlights(DOC)
		const gone: TextCommentHighlight = {
			id: 'gone',
			anchor: { quote: 'not in the file', prefix: '', suffix: '' },
		}
		setTextComments(editor.view, [{ id: 'c1', anchor: anchorFor(editor, 'lazy dog') }, gone], null)
		await Promise.resolve()
		expect(calls.orphaned.at(-1)).toEqual(['gone'])
		expect(editor.view.dom.querySelector('[data-comment-id="gone"]')).toBeNull()
		expect(textCommentRange(editor.state, 'gone')).toBeNull()
		expect(textCommentRange(editor.state, 'c1')).not.toBeNull()
		destroy()
	})

	it('orphans a comment when its passage is edited away, and keeps the others', async () => {
		const { editor, calls, destroy } = withHighlights(DOC)
		const comments: TextCommentHighlight[] = [
			{ id: 'a', anchor: anchorFor(editor, 'lazy dog') },
			{ id: 'b', anchor: anchorFor(editor, 'Title of') },
		]
		setTextComments(editor.view, comments, null)
		await Promise.resolve()
		const { from, to } = rangeOf(editor, 'lazy dog')
		editor.commands.insertContentAt({ from, to }, 'sleepy cat')
		await Promise.resolve()
		expect(calls.orphaned.at(-1)).toEqual(['a'])
		expect(editor.view.dom.querySelector('[data-comment-id="b"]')).not.toBeNull()
		destroy()
	})

	it('survives an unrelated edit elsewhere in the document', async () => {
		const { editor, calls, destroy } = withHighlights(DOC)
		setTextComments(editor.view, [{ id: 'a', anchor: anchorFor(editor, 'lazy dog') }], null)
		const title = rangeOf(editor, 'Title')
		editor.commands.insertContentAt({ from: title.from, to: title.to }, 'Name')
		await Promise.resolve()
		expect(calls.orphaned.at(-1) ?? []).toEqual([])
		expect(editor.view.dom.querySelector('[data-comment-id="a"]')?.textContent).toBe('lazy dog')
		destroy()
	})

	it('does not report a pending selection as orphaned', async () => {
		const { editor, calls, destroy } = withHighlights(DOC)
		setTextComments(
			editor.view,
			[{ id: 'pending', anchor: { quote: 'nowhere', prefix: '', suffix: '' }, pending: true }],
			null,
		)
		await Promise.resolve()
		expect(calls.orphaned.at(-1) ?? []).toEqual([])
		destroy()
	})
})
