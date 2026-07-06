import { ZERO_WIDTH_SPACE } from '@/lib/html-to-markdown'
import { applyMarkdownInputRules } from '@/lib/markdown-input-rules'
import { afterEach, describe, expect, it } from 'vitest'

let root: HTMLDivElement | null = null

afterEach(() => {
	root?.remove()
	root = null
	window.getSelection()?.removeAllRanges()
})

function setup(html: string): HTMLDivElement {
	const div = document.createElement('div')
	div.contentEditable = 'true'
	div.innerHTML = html
	document.body.appendChild(div)
	root = div
	return div
}

function placeCaret(node: Node, offset: number) {
	const range = document.createRange()
	range.setStart(node, offset)
	range.setEnd(node, offset)
	const selection = window.getSelection()
	selection?.removeAllRanges()
	selection?.addRange(range)
}

// Types `text` into a fresh, empty contentEditable div as a single bare text
// node (mirroring what a real browser does when typing into empty content —
// no wrapping <p> is created until Enter/our own surgery adds one), with the
// caret placed at the very end.
function typeIntoFreshDiv(text: string): HTMLDivElement {
	const div = setup('')
	const textNode = document.createTextNode(text)
	div.appendChild(textNode)
	placeCaret(textNode, text.length)
	return div
}

describe('applyMarkdownInputRules — inline', () => {
	// Every conversion below appends a trailing zero-width-space text node after
	// the new inline element. A collapsed selection positioned at a bare
	// parent-boundary (no text node) isn't a reliable target for *native*
	// typing in Chrome — it tends to keep extending the just-inserted element's
	// formatting instead of starting fresh plain text. html-to-markdown.ts
	// strips it before saving. See the usage site in markdown-input-rules.ts.

	it('converts **text** to <strong>', () => {
		const div = typeIntoFreshDiv('**bold**')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<strong>bold</strong>${ZERO_WIDTH_SPACE}`)
	})

	it('converts __text__ to <strong>', () => {
		const div = typeIntoFreshDiv('__bold__')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<strong>bold</strong>${ZERO_WIDTH_SPACE}`)
	})

	it('converts *text* to <em>', () => {
		const div = typeIntoFreshDiv('*italic*')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<em>italic</em>${ZERO_WIDTH_SPACE}`)
	})

	it('converts _text_ to <em>', () => {
		const div = typeIntoFreshDiv('_italic_')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<em>italic</em>${ZERO_WIDTH_SPACE}`)
	})

	it('converts `text` to <code>', () => {
		const div = typeIntoFreshDiv('`code`')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<code>code</code>${ZERO_WIDTH_SPACE}`)
	})

	it('converts ~~text~~ to <del>', () => {
		const div = typeIntoFreshDiv('~~strike~~')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<del>strike</del>${ZERO_WIDTH_SPACE}`)
	})

	it('converts mid-sentence, keeping surrounding text intact', () => {
		const div = typeIntoFreshDiv('hello **world**')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`hello <strong>world</strong>${ZERO_WIDTH_SPACE}`)
	})

	it('places the cursor in the trailing anchor, ready to keep typing outside the element', () => {
		const div = typeIntoFreshDiv('**bold**')
		applyMarkdownInputRules(div)
		const strong = div.querySelector('strong')
		expect(strong).not.toBeNull()

		const selection = window.getSelection()
		expect(selection?.isCollapsed).toBe(true)
		expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE)
		expect(selection?.anchorNode?.textContent).toBe(ZERO_WIDTH_SPACE)
		expect(selection?.anchorNode?.previousSibling).toBe(strong)
	})

	it('does not trigger on a single trailing "*" with no closing pair', () => {
		const div = typeIntoFreshDiv('just some *text')
		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('just some *text')
	})

	it('does not misfire italic while typing the closing "*" of "**bold**" one character at a time', () => {
		// "**bold*" — only one of the two closing asterisks typed so far. A naive
		// /\*([^*]+)\*$/ would match "*bold*" using the second "*" of the opening
		// "**" as italic's own opening delimiter — the negative lookbehind must
		// prevent that.
		const div = typeIntoFreshDiv('**bold*')
		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('**bold*')
	})

	it('converts to <strong> (not <em>) once the second closing "*" completes the bold pair', () => {
		const div = typeIntoFreshDiv('**bold**')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.querySelector('strong')).not.toBeNull()
		expect(div.querySelector('em')).toBeNull()
	})

	it('does not misfire italic while typing the closing "_" of "__bold__" one character at a time', () => {
		const div = typeIntoFreshDiv('__bold_')
		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('__bold_')
	})

	it('does not convert bold/italic/strikethrough while inside an unclosed code span', () => {
		// One backtick before the match (odd count) means we're still "inside" an
		// unclosed `code span — typing "**bold**" there shouldn't convert before
		// the span itself is closed.
		const div = typeIntoFreshDiv('`some **bold**')
		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('`some **bold**')
	})

	it('still converts a code span itself even though it contains backticks', () => {
		const div = typeIntoFreshDiv('`code`')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.querySelector('code')).toHaveTextContent('code')
	})
})

describe('applyMarkdownInputRules — block, fresh (first line of a block)', () => {
	// New (empty) block elements are seeded with a zero-width space so Chrome
	// gives them a real layout box/caret to type into (see markdown-input-rules.ts).
	// html-to-markdown.ts strips it before saving, so it's invisible to the user
	// and never persists — but it is genuinely present in the live DOM.

	it('converts "# " to an <h1> (with the zero-width-space caret anchor)', () => {
		const div = typeIntoFreshDiv('# ')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<h1>${ZERO_WIDTH_SPACE}</h1>`)
	})

	it('converts "###### " to an <h6> (with the zero-width-space caret anchor)', () => {
		const div = typeIntoFreshDiv('###### ')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<h6>${ZERO_WIDTH_SPACE}</h6>`)
	})

	it.each(['-', '*', '+'])('converts "%s " to a bullet list', (marker) => {
		const div = typeIntoFreshDiv(`${marker} `)
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<ul><li>${ZERO_WIDTH_SPACE}</li></ul>`)
	})

	it('converts "1. " to an ordered list with no start attribute', () => {
		const div = typeIntoFreshDiv('1. ')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<ol><li>${ZERO_WIDTH_SPACE}</li></ol>`)
	})

	it('converts "3. " to an ordered list with start="3"', () => {
		const div = typeIntoFreshDiv('3. ')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<ol start="3"><li>${ZERO_WIDTH_SPACE}</li></ol>`)
	})

	it('converts "> " to a blockquote wrapping a <p>', () => {
		const div = typeIntoFreshDiv('> ')
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<blockquote><p>${ZERO_WIDTH_SPACE}</p></blockquote>`)
	})

	it('converts a heading marker with a non-breaking trailing space to an <h1>', () => {
		// Chrome/Firefox convert a trailing space in contentEditable to a
		// non-breaking space (U+00A0) to stop it collapsing per HTML whitespace
		// rules — real typing produces this, not a literal ASCII space. Caught via
		// manual browser verification when this initially only matched " ".
		const div = typeIntoFreshDiv(`#${' '}`)
		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe(`<h1>${ZERO_WIDTH_SPACE}</h1>`)
	})

	it('places the cursor inside the new heading, after the zero-width-space anchor', () => {
		const div = typeIntoFreshDiv('# ')
		applyMarkdownInputRules(div)
		const h1 = div.querySelector('h1')
		const selection = window.getSelection()
		expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE)
		expect(selection?.anchorNode?.parentNode).toBe(h1)
		expect(selection?.anchorOffset).toBe(0)
	})

	it('places the cursor inside the new list item, after the zero-width-space anchor', () => {
		const div = typeIntoFreshDiv('- ')
		applyMarkdownInputRules(div)
		const li = div.querySelector('li')
		const selection = window.getSelection()
		expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE)
		expect(selection?.anchorNode?.parentNode).toBe(li)
	})
})

describe('applyMarkdownInputRules — block, sibling sweep', () => {
	it('sweeps trailing inline-formatted siblings into the new block instead of deleting them', () => {
		// Marker typed at the very start of a paragraph that already has other
		// content: <p>ered text <strong>bold</strong> end</p> — converting must
		// preserve everything after the marker, not silently drop it.
		const div = setup('<p><strong>bold</strong> end</p>')
		const p = div.querySelector('p') as HTMLParagraphElement
		const textNode = document.createTextNode('# ')
		p.insertBefore(textNode, p.firstChild)
		placeCaret(textNode, 2)

		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe('<h1><strong>bold</strong> end</h1>')
	})

	it('stops the sweep at a <br>, leaving a later line in the paragraph as an untouched sibling', () => {
		// <p># line one<br>line two</p> — converting "line one" to a heading must
		// produce <h1>line one</h1><p>line two</p>, not swallow "line two".
		const div = setup('')
		const p = document.createElement('p')
		const textNode = document.createTextNode('# line one')
		p.appendChild(textNode)
		p.appendChild(document.createElement('br'))
		p.appendChild(document.createTextNode('line two'))
		div.appendChild(p)
		placeCaret(textNode, 2)

		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.innerHTML).toBe('<h1>line one</h1><p>line two</p>')
	})

	it('still recognizes a block-start line past a stray leading empty text node', () => {
		// Defensive: a stray empty text node ahead of the real content (e.g. from
		// some DOM operation outside our own insertNodeAtCursor/insertNode
		// callers, which already clean up after themselves) must not defeat the
		// "is this the first meaningful content in the block" check.
		const div = setup('')
		const p = document.createElement('p')
		p.appendChild(document.createTextNode(''))
		const textNode = document.createTextNode('# ')
		p.appendChild(textNode)
		div.appendChild(p)
		placeCaret(textNode, 2)

		expect(applyMarkdownInputRules(div)).toBe(true)
		expect(div.querySelector('h1')).not.toBeNull()
	})
})

describe('applyMarkdownInputRules — block, no continuation after a manual line break', () => {
	// Enter always inserts a flat <br> (never a new block element), so a line
	// after a manual <br> is mid-block content, not a block start — there is no
	// list/heading "continuation" in v1.
	it('does not convert a heading marker typed on a line after a manual <br>', () => {
		const div = setup('<p>first line<br></p>')
		const p = div.querySelector('p') as HTMLParagraphElement
		const textNode = document.createTextNode('# ')
		p.appendChild(textNode)
		placeCaret(textNode, 2)

		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('<p>first line<br># </p>')
	})

	it('does not convert a list marker typed on a line after a manual <br>', () => {
		const div = setup('<p>first line<br></p>')
		const p = div.querySelector('p') as HTMLParagraphElement
		const textNode = document.createTextNode('- ')
		p.appendChild(textNode)
		placeCaret(textNode, 2)

		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('<p>first line<br>- </p>')
	})
})

describe('applyMarkdownInputRules — block negative cases', () => {
	it('does not trigger when the marker is not at the start of the line', () => {
		const div = typeIntoFreshDiv('hello # ')
		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('hello # ')
	})

	it('does not trigger when other content precedes the marker in the same block', () => {
		const div = setup('<p><strong>x</strong></p>')
		const p = div.querySelector('p') as HTMLParagraphElement
		const textNode = document.createTextNode('# ')
		p.appendChild(textNode)
		placeCaret(textNode, 2)

		expect(applyMarkdownInputRules(div)).toBe(false)
		expect(div.innerHTML).toBe('<p><strong>x</strong># </p>')
	})
})

describe('applyMarkdownInputRules — no-op guards', () => {
	it('returns false when there is no selection', () => {
		const div = setup('<p>text</p>')
		window.getSelection()?.removeAllRanges()
		expect(applyMarkdownInputRules(div)).toBe(false)
	})

	it('returns false when the focus node is outside root', () => {
		const div = setup('<p>text</p>')
		const outside = document.createElement('div')
		document.body.appendChild(outside)
		const outsideText = document.createTextNode('**bold**')
		outside.appendChild(outsideText)
		placeCaret(outsideText, outsideText.length)

		expect(applyMarkdownInputRules(div)).toBe(false)
		outside.remove()
	})
})
