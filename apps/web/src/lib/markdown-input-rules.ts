// Live markdown-syntax-to-formatting conversion for the contentEditable editor
// in markdown-content.tsx. Runs reactively after the browser has already
// inserted typed/pasted text (the same "input rule" pattern used by
// ProseMirror/TipTap) — never intercepts keystrokes preemptively.

import { ZERO_WIDTH_SPACE } from './html-to-markdown'

// Bold/strikethrough/code are checked before italic for the same delimiter —
// the real guard against misfiring while mid-typing "**bold**" is the
// negative lookbehind on the italic patterns: without it, typing "**bold*"
// (one of the two closing "*"s so far) would match "*bold*" using the second
// "*" of the opening "**" as italic's own opening delimiter. The lookbehind
// rejects any opening "*"/"_" that is itself preceded by another "*"/"_".
const INLINE_RULES: Array<{ regex: RegExp; tag: 'strong' | 'em' | 'code' | 'del' }> = [
	{ regex: /\*\*([^*]+)\*\*$/, tag: 'strong' },
	{ regex: /__([^_]+)__$/, tag: 'strong' },
	{ regex: /`([^`]+)`$/, tag: 'code' },
	{ regex: /~~([^~]+)~~$/, tag: 'del' },
	{ regex: /(?<!\*)\*([^*]+)\*$/, tag: 'em' },
	{ regex: /(?<!_)_([^_]+)_$/, tag: 'em' },
]

// A bold/italic/strikethrough marker typed while inside an unclosed backtick
// span (odd number of backticks before it) must not convert — e.g. typing
// `` `some **bold` `` shouldn't turn "**bold" into <strong> before the
// backtick span itself is even closed.
function isInsideOpenCodeSpan(textBeforeMatch: string): boolean {
	return (textBeforeMatch.match(/`/g) ?? []).length % 2 === 1
}

function wrap(outerTag: string, innerTag: string, start?: number): HTMLElement {
	const outer = document.createElement(outerTag)
	if (start !== undefined && start !== 1) outer.setAttribute('start', String(start))
	outer.appendChild(document.createElement(innerTag))
	return outer
}

// Chrome/Firefox convert a trailing space in contentEditable to a
// non-breaking space (U+00A0) to stop it from being collapsed away, per
// normal HTML whitespace rules — verified via manual browser testing that a
// literal " " alone never matches real typed input. Every marker below
// accepts either.
const SPACE = '[  ]'

type BlockRule = { regex: RegExp; build: (m: RegExpMatchArray) => HTMLElement }

const BLOCK_RULES: BlockRule[] = [
	{
		regex: new RegExp(`^(#{1,6})${SPACE}$`),
		build: (m) => document.createElement(`h${m[1].length}`),
	},
	{ regex: new RegExp(`^[-*+]${SPACE}$`), build: () => wrap('ul', 'li') },
	{ regex: new RegExp(`^(\\d+)\\.${SPACE}$`), build: (m) => wrap('ol', 'li', Number(m[1])) },
	{ regex: new RegExp(`^>${SPACE}$`), build: () => wrap('blockquote', 'p') },
]

// Block rules fire once per block, on the true first line only. Per the
// architecture, Enter always inserts a flat <br> (never a new block element),
// so a line after a manual <br> is mid-block content, not a block start —
// there is no list/heading "continuation" in v1: typing a second "- " line
// after pressing Enter does not create a second list item.
function isStartOfBlock(node: Node, root: HTMLElement): boolean {
	const parent = node.parentElement
	if (!parent) return false
	// Skip past any leading empty text nodes before deciding whether `node` is
	// the first *meaningful* content in parent — defensive against a stray
	// empty text node from any source (our own insertNodeAtCursor/insertNode
	// callers already clean up after themselves, but this keeps the check
	// correct even if one slips in from elsewhere, e.g. a browser-native
	// contentEditable quirk outside our own DOM surgery).
	let sibling: ChildNode | null = parent.firstChild
	while (
		sibling &&
		sibling !== node &&
		sibling.nodeType === Node.TEXT_NODE &&
		sibling.textContent === ''
	) {
		sibling = sibling.nextSibling
	}
	if (sibling !== node) return false
	if (parent === root) return true
	return /^(P|LI|H[1-6]|BLOCKQUOTE)$/.test(parent.tagName)
}

function innermostContentHolder(el: HTMLElement): HTMLElement {
	if (/^H[1-6]$/.test(el.tagName)) return el
	return el.firstElementChild as HTMLElement
}

function placeCaretAtStart(target: HTMLElement) {
	const range = document.createRange()
	const firstChild = target.firstChild
	if (!firstChild) {
		// A collapsed selection inside a genuinely childless element doesn't
		// reliably accept further *native* typing in Chrome — verified via
		// manual browser testing (an empty heading isn't even clickable, let
		// alone typeable — Playwright reported "element is not visible"). A
		// zero-width-space text-node anchor fixes it; stripped from saved
		// markdown in html-to-markdown.ts. Only needed when nothing was swept
		// in (target truly has no content of its own).
		const anchor = document.createTextNode(ZERO_WIDTH_SPACE)
		target.appendChild(anchor)
		range.setStart(anchor, 0)
		range.setEnd(anchor, 0)
	} else if (firstChild.nodeType === Node.TEXT_NODE) {
		range.setStart(firstChild, 0)
		range.setEnd(firstChild, 0)
	} else {
		// First swept child is an element (e.g. sweeping preserved a leading
		// <strong>) — target already has real content/layout, so a plain
		// before-first-child position is a perfectly ordinary, reliable caret
		// target (same as clicking at the start of any non-empty element).
		range.setStart(target, 0)
		range.setEnd(target, 0)
	}
	const selection = window.getSelection()
	selection?.removeAllRanges()
	selection?.addRange(range)
}

// Converts the current line into `newElement`. Sweeps the trimmed text node
// and all following siblings into the new block's innermost content holder,
// stopping at the next <br> (a later line within the same paragraph) or the
// end of the parent's children — this preserves any inline-formatted content
// after the marker (e.g. converting the start of
// `<p>text <strong>bold</strong> end</p>` into a heading must not silently
// delete "bold end") and any `<br>`-separated later line in the same
// paragraph (which must survive as an untouched following sibling).
function applyBlockRule(
	textNode: Text,
	offset: number,
	newElement: HTMLElement,
	root: HTMLElement,
) {
	const parent = textNode.parentElement
	if (!parent) return
	textNode.textContent = (textNode.textContent ?? '').slice(offset)
	const target = innermostContentHolder(newElement)

	let node: ChildNode | null = textNode
	while (node && node.nodeName !== 'BR') {
		const next: ChildNode | null = node.nextSibling
		// The marker's own text node is often empty after trimming (nothing
		// followed the marker in it) — drop it instead of sweeping a useless
		// empty node, so target's first real child (if any) is meaningful
		// content for placeCaretAtStart to anchor to.
		if (node.nodeType === Node.TEXT_NODE && node.textContent === '') {
			node.remove()
		} else {
			target.appendChild(node)
		}
		node = next
	}

	if (parent === root) {
		root.insertBefore(newElement, node) // insertBefore(x, null) appends — correct either way
	} else if (node === null) {
		parent.replaceWith(newElement) // whole paragraph was this one line — replace outright
	} else {
		parent.before(newElement) // parent still holds a later <br>-separated line — keep it as a following sibling
		// `node` (the boundary <br>) is now parent.firstChild — a now-meaningless
		// leading line break. Cosmetic cleanup only; self-corrects on save/reload
		// regardless of whether this runs.
		if (node.nodeName === 'BR' && node === parent.firstChild) {
			parent.removeChild(node)
		}
	}
	placeCaretAtStart(target)
}

function applyInlineRule(textNode: Text, offset: number, match: RegExpMatchArray, tag: string) {
	const matchStart = offset - match[0].length
	const range = document.createRange()
	range.setStart(textNode, matchStart)
	range.setEnd(textNode, offset)
	range.deleteContents()

	const el = document.createElement(tag)
	el.textContent = match[1] // literal — no nested parsing in v1
	range.insertNode(el)

	// insertNode() splits a Text node even when the boundary is exactly at its
	// end, leaving a stray empty Text node as el's next sibling. Harmless on
	// its own, but cleaned up for hygiene (and so a later block-rule sibling
	// sweep never has to think about it).
	if (el.nextSibling?.nodeType === Node.TEXT_NODE && el.nextSibling.textContent === '') {
		el.nextSibling.remove()
	}

	// A collapsed selection at a parent-boundary position right after an
	// inline element (no text node there yet) isn't a reliable target for
	// further *native* typing — verified via manual browser testing: Chrome
	// kept extending the just-inserted element's formatting for subsequent
	// keystrokes instead of starting fresh plain text. A real trailing
	// zero-width-space text node anchors the caret properly; stripped from
	// saved markdown in html-to-markdown.ts.
	const anchor = document.createTextNode(ZERO_WIDTH_SPACE)
	el.after(anchor)
	const cursorRange = document.createRange()
	cursorRange.setStart(anchor, anchor.length)
	cursorRange.setEnd(anchor, anchor.length)

	const selection = window.getSelection()
	selection?.removeAllRanges()
	selection?.addRange(cursorRange)
}

// Inspects the current (collapsed) selection inside `root` and converts a
// just-completed markdown trigger pattern into real formatting. Returns
// whether a conversion was applied. No-ops (and is cheap) when nothing
// matches, so it's safe to call on every `input` event.
export function applyMarkdownInputRules(root: HTMLElement): boolean {
	const selection = window.getSelection()
	if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false
	const anchorNode = selection.anchorNode
	if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) return false
	if (!root.contains(anchorNode)) return false

	const textNode = anchorNode as Text
	const offset = selection.anchorOffset
	const textBefore = (textNode.textContent ?? '').slice(0, offset)

	if (isStartOfBlock(textNode, root)) {
		for (const rule of BLOCK_RULES) {
			const match = textBefore.match(rule.regex)
			if (match) {
				applyBlockRule(textNode, offset, rule.build(match), root)
				return true
			}
		}
	}

	for (const rule of INLINE_RULES) {
		const match = textBefore.match(rule.regex)
		if (!match) continue
		if (rule.tag !== 'code') {
			const preceding = textBefore.slice(0, textBefore.length - match[0].length)
			if (isInsideOpenCodeSpan(preceding)) continue
		}
		applyInlineRule(textNode, offset, match, rule.tag)
		return true
	}
	return false
}
