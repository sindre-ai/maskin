// Highlights for comments on selected text, drawn as editor decorations.
//
// A highlight is a view of the comment list over the document. It is never a
// mark, never has an id in the document, and is never serialised, so the
// markdown is byte-identical with or without comments. Each comment's quote is
// matched against the editor's rendered text on every change to the document;
// a quote with no match is reported as orphaned and gets no highlight.

import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
	type EditorState,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { type RenderedText, type TextAnchor, findAnchorRange, renderedText } from './text-anchor'

export interface TextCommentHighlight {
	id: string
	anchor: TextAnchor
	/** Resolved comments keep a clickable highlight with no background. */
	resolved?: boolean
	/** The passage a person is composing a comment on; drawn like a highlight, never reported orphaned. */
	pending?: boolean
}

export interface CommentHighlightHandlers {
	/** A highlight was clicked (its id), or the click landed elsewhere in the text (null). */
	onHighlightClick?: (id: string | null) => void
	/** The set of comments whose quote no longer matches changed. */
	onOrphansChange?: (orphanedIds: string[]) => void
	/** Element id of the panel card a highlight points at, for aria-describedby. */
	describedBy?: (id: string) => string | undefined
}

interface HighlightPluginState {
	comments: TextCommentHighlight[]
	activeId: string | null
	decorations: DecorationSet
	orphaned: string[]
	ranges: Map<string, { from: number; to: number }>
}

interface HighlightMeta {
	comments?: TextCommentHighlight[]
	activeId?: string | null
}

export const commentHighlightsKey = new PluginKey<HighlightPluginState>('maskinCommentHighlights')

const BASE_CLASS = 'maskin-comment-highlight'

function compute(
	doc: ProseMirrorNode,
	comments: TextCommentHighlight[],
	activeId: string | null,
	describedBy: CommentHighlightHandlers['describedBy'],
): Omit<HighlightPluginState, 'comments' | 'activeId'> {
	if (comments.length === 0) {
		return { decorations: DecorationSet.empty, orphaned: [], ranges: new Map() }
	}
	const rendered: RenderedText = renderedText(doc)
	const decorations: Decoration[] = []
	const orphaned: string[] = []
	const ranges = new Map<string, { from: number; to: number }>()
	for (const comment of comments) {
		const range = findAnchorRange(rendered, comment.anchor)
		if (!range) {
			if (!comment.pending) orphaned.push(comment.id)
			continue
		}
		ranges.set(comment.id, range)
		const classes = [BASE_CLASS]
		if (comment.resolved) classes.push(`${BASE_CLASS}--resolved`)
		if (comment.pending) classes.push(`${BASE_CLASS}--pending`)
		if (comment.id === activeId) classes.push(`${BASE_CLASS}--active`)
		const attrs: Record<string, string> = {
			class: classes.join(' '),
			'data-comment-id': comment.id,
		}
		const card = comment.pending ? undefined : describedBy?.(comment.id)
		if (card) attrs['aria-describedby'] = card
		decorations.push(Decoration.inline(range.from, range.to, attrs))
	}
	return { decorations: DecorationSet.create(doc, decorations), orphaned, ranges }
}

/**
 * Tiptap extension that draws comment highlights. Handlers are read through a
 * ref so the extension (and with it the editor) stays stable across renders;
 * the host pushes the comment list in with setTextComments.
 */
export function createCommentHighlights(handlers: { current: CommentHighlightHandlers }) {
	return Extension.create({
		name: 'maskinCommentHighlights',

		addProseMirrorPlugins() {
			return [
				new Plugin<HighlightPluginState>({
					key: commentHighlightsKey,
					state: {
						init: () => ({
							comments: [],
							activeId: null,
							decorations: DecorationSet.empty,
							orphaned: [],
							ranges: new Map(),
						}),
						apply(tr, value, _oldState, newState) {
							const meta = tr.getMeta(commentHighlightsKey) as HighlightMeta | undefined
							if (!meta && !tr.docChanged) return value
							const comments = meta?.comments ?? value.comments
							const activeId = meta && 'activeId' in meta ? (meta.activeId ?? null) : value.activeId
							return {
								comments,
								activeId,
								...compute(newState.doc, comments, activeId, handlers.current.describedBy),
							}
						},
					},
					props: {
						decorations: (state) => commentHighlightsKey.getState(state)?.decorations,
						handleClick: (_view, _pos, event) => {
							const target = event.target
							if (!(target instanceof Element)) return false
							const id = target.closest(`.${BASE_CLASS}`)?.getAttribute('data-comment-id')
							handlers.current.onHighlightClick?.(id ?? null)
							// Never swallow the click: the caret still lands where it was clicked.
							return false
						},
					},
					view: () => {
						// Null until the first update, so a freshly mounted editor always
						// tells the host where it stands, even when nothing is orphaned.
						let reported: string | null = null
						return {
							update: (view) => {
								const orphaned = commentHighlightsKey.getState(view.state)?.orphaned ?? []
								const key = orphaned.join(',')
								if (key === reported) return
								reported = key
								// Out of the view update, so a host setState never lands mid-render.
								queueMicrotask(() => handlers.current.onOrphansChange?.(orphaned))
							},
						}
					},
				}),
			]
		},
	})
}

/** Hand the editor the comments to draw. Draws nothing into the document. */
export function setTextComments(
	view: EditorView,
	comments: TextCommentHighlight[],
	activeId: string | null,
): void {
	const meta: HighlightMeta = { comments, activeId }
	const tr = view.state.tr.setMeta(commentHighlightsKey, meta).setMeta('addToHistory', false)
	view.dispatch(withPageSelection(view, tr))
}

/**
 * A click moves the selection on the page before the editor reads it. A redraw
 * dispatched from that click (clicking off a highlight clears the active one)
 * would otherwise carry the old selection and put it back on the page.
 */
function withPageSelection(view: EditorView, tr: Transaction): Transaction {
	if (!view.hasFocus() || !(tr.selection instanceof TextSelection)) return tr
	const page = view.dom.ownerDocument.getSelection()
	const { anchorNode, focusNode } = page ?? {}
	if (!page || !anchorNode || !focusNode) return tr
	if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return tr
	try {
		const anchor = view.posAtDOM(anchorNode, page.anchorOffset)
		const head = view.posAtDOM(focusNode, page.focusOffset)
		if (anchor === tr.selection.anchor && head === tr.selection.head) return tr
		if (
			!tr.doc.resolve(anchor).parent.inlineContent ||
			!tr.doc.resolve(head).parent.inlineContent
		) {
			return tr
		}
		return tr.setSelection(TextSelection.create(tr.doc, anchor, head))
	} catch {
		return tr
	}
}

/** The document range a comment is currently drawn at, or null when orphaned or unknown. */
export function textCommentRange(
	state: EditorState,
	id: string,
): { from: number; to: number } | null {
	return commentHighlightsKey.getState(state)?.ranges.get(id) ?? null
}
