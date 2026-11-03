// Text anchors for comments on selected text.
//
// An anchor is the quoted passage plus a little context on each side. It is
// matched against the editor's rendered text (ProseMirror text, block
// boundaries as separators), never against the raw markdown, and the match is
// only ever drawn as a decoration. Nothing here writes into the document.

import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model'

/** Same shape as TextAnchor in @maskin/shared; kept local so this package stays standalone. */
export interface TextAnchor {
	quote: string
	prefix: string
	suffix: string
}

export const MAX_ANCHOR_QUOTE = 500
export const ANCHOR_CONTEXT_LENGTH = 24

/** Stands in for a block boundary or a non-text inline node (a hard break, an image). */
const SEPARATOR = '\n'

/** Blocks that may not hold a text comment in the first cut. */
const BLOCKED_ANCESTORS = new Set([
	'bulletList',
	'orderedList',
	'listItem',
	'taskList',
	'taskItem',
	'table',
	'tableRow',
	'tableCell',
	'tableHeader',
	'codeBlock',
])

const COMMENTABLE_BLOCKS = new Set(['paragraph', 'heading'])

/** Flat text of a document, with the document position of every character. */
export interface RenderedText {
	text: string
	/** positions[i] is the document position just before text[i], or -1 for a separator. */
	positions: number[]
}

export function renderedText(doc: ProseMirrorNode): RenderedText {
	let text = ''
	const positions: number[] = []
	let first = true
	doc.descendants((node, pos) => {
		if (node.isText) {
			const value = node.text ?? ''
			for (let i = 0; i < value.length; i++) {
				text += value[i]
				positions.push(pos + i)
			}
			return false
		}
		if (node.isTextblock) {
			if (!first) {
				text += SEPARATOR
				positions.push(-1)
			}
			first = false
			return true
		}
		if (node.isLeaf) {
			// A hard break or an image inside a paragraph reads as a line break.
			text += SEPARATOR
			positions.push(-1)
			return false
		}
		return true
	})
	return { text, positions }
}

function isInsideBlockedNode($pos: ResolvedPos): boolean {
	for (let depth = $pos.depth; depth > 0; depth--) {
		if (BLOCKED_ANCESTORS.has($pos.node(depth).type.name)) return true
	}
	return false
}

/**
 * True when a selection may carry a text comment: it sits inside one paragraph
 * or heading (not in a list, table or code block), and holds some text.
 */
export function isCommentableSelection(doc: ProseMirrorNode, from: number, to: number): boolean {
	if (from >= to) return false
	const $from = doc.resolve(from)
	const $to = doc.resolve(to)
	if (!$from.sameParent($to)) return false
	if (!COMMENTABLE_BLOCKS.has($from.parent.type.name)) return false
	if (isInsideBlockedNode($from)) return false
	const selected = $from.parent.textBetween(
		$from.parentOffset,
		$to.parentOffset,
		SEPARATOR,
		SEPARATOR,
	)
	return selected.trim().length > 0
}

/**
 * The anchor for a selection: the quote (capped at 500 characters) and about
 * 24 characters of rendered text on each side. Null when the selection cannot
 * carry a comment.
 */
export function captureTextAnchor(
	doc: ProseMirrorNode,
	from: number,
	to: number,
): TextAnchor | null {
	if (!isCommentableSelection(doc, from, to)) return null
	const rendered = renderedText(doc)
	const start = rendered.positions.findIndex((position) => position !== -1 && position >= from)
	if (start === -1) return null
	let end = start
	while (end < rendered.positions.length) {
		const position = rendered.positions[end] ?? -1
		if (position !== -1 && position >= to) break
		end++
	}
	const quote = rendered.text.slice(start, end).slice(0, MAX_ANCHOR_QUOTE)
	if (quote.trim().length === 0) return null
	const quoteEnd = start + quote.length
	return {
		quote,
		prefix: rendered.text.slice(Math.max(0, start - ANCHOR_CONTEXT_LENGTH), start),
		suffix: rendered.text.slice(quoteEnd, quoteEnd + ANCHOR_CONTEXT_LENGTH),
	}
}

function commonSuffixLength(a: string, b: string): number {
	let n = 0
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
	return n
}

function commonPrefixLength(a: string, b: string): number {
	let n = 0
	while (n < a.length && n < b.length && a[n] === b[n]) n++
	return n
}

/**
 * Where an anchor sits in the rendered text, as an index into it. A quote that
 * occurs once is that occurrence. A quote that occurs several times goes to the
 * occurrence whose surrounding text agrees most with the saved prefix and
 * suffix; a tie goes to the first. Null when the quote is gone.
 */
export function findQuoteIndex(rendered: RenderedText, anchor: TextAnchor): number | null {
	const { quote, prefix, suffix } = anchor
	if (quote.length === 0) return null
	let best = -1
	let bestScore = -1
	let index = rendered.text.indexOf(quote)
	while (index !== -1) {
		const before = rendered.text.slice(Math.max(0, index - prefix.length), index)
		const after = rendered.text.slice(index + quote.length, index + quote.length + suffix.length)
		const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix)
		if (score > bestScore) {
			best = index
			bestScore = score
		}
		index = rendered.text.indexOf(quote, index + 1)
	}
	return best === -1 ? null : best
}

/** The document range an anchor covers, or null when its quote no longer matches. */
export function findAnchorRange(
	rendered: RenderedText,
	anchor: TextAnchor,
): { from: number; to: number } | null {
	const index = findQuoteIndex(rendered, anchor)
	if (index === null) return null
	let first = -1
	let last = -1
	for (let i = index; i < index + anchor.quote.length; i++) {
		const position = rendered.positions[i] ?? -1
		if (position === -1) continue
		if (first === -1) first = position
		last = position
	}
	if (first === -1) return null
	return { from: first, to: last + 1 }
}
