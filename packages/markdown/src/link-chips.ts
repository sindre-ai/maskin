// Link chips in the live editor, drawn as editor decorations.
//
// A chip is a view of a link over the document. It is never a node or a mark and is never
// serialised, so the markdown is byte-identical with or without chips. For each link the host
// recognises, the link text is hidden and a widget carrying the chip is drawn in front of it.
// A link the cursor touches (inside it, or on either edge, or at either end of a selection) is
// left as plain text so it can be edited one letter at a time; when the editor has no focus every
// link is a chip. The chip itself is drawn by the host (it needs the app's data and components),
// which is handed an element to draw into.

import { Extension } from '@tiptap/core'
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Selection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { withPageSelection } from './comment-highlights'

/** What the host knows about an address it will draw a chip for. */
export interface LinkChipTarget {
	/**
	 * Names what drawing the chip costs a lookup for, such as "object:<id>". Chips that share a
	 * name share one lookup; at most {@link LinkChipHost.maxLookups} different names get a chip.
	 * Leave it out for a chip built from the address alone.
	 */
	lookup?: string
}

export interface LinkChipHost {
	/** The chip an address gets, or null when it stays a plain link. Must be cheap and not fetch. */
	chipFor(href: string): LinkChipTarget | null
	/** Draw the chip for a link into `container`. Called once for each chip element. */
	mount(container: HTMLElement, link: { href: string; text: string }): void
	/** The chip element left the editor; stop drawing into it. */
	unmount(container: HTMLElement): void
	/** Open the link's target, in a new tab. */
	open(href: string): void
	/** The lookups one body may cost. Links past it stay plain. */
	maxLookups: number
}

export interface LinkChipHandlers {
	host: LinkChipHost | null
}

interface LinkChipState {
	host: LinkChipHost | null
	/** Counts host changes, so chips drawn by an earlier host are redrawn, not reused. */
	generation: number
	focused: boolean
	decorations: DecorationSet
}

interface LinkChipMeta {
	host?: LinkChipHost | null
	focused?: boolean
}

export const linkChipsKey = new PluginKey<LinkChipState>('maskinLinkChips')

const CHIP_CLASS = 'maskin-link-chip'
const SOURCE_CLASS = 'maskin-link-chip-source'

/** A link as the document holds it: one address over one unbroken run of text. */
export interface LinkRun {
	href: string
	from: number
	to: number
}

/** The links in a document, in reading order. Bold or italic inside a link does not split it. */
export function linkRuns(doc: ProseMirrorNode): LinkRun[] {
	const runs: LinkRun[] = []
	let mark: Mark | null = null
	let open: LinkRun | null = null
	doc.descendants((node, pos) => {
		const link = node.isText ? node.marks.find((m) => m.type.name === 'link') : undefined
		const href = link?.attrs.href
		if (!link || typeof href !== 'string' || href === '') {
			open = null
			mark = null
			return
		}
		if (open && mark?.eq(link) && open.to === pos) {
			open.to = pos + node.nodeSize
			return
		}
		mark = link
		open = { href, from: pos, to: pos + node.nodeSize }
		runs.push(open)
	})
	return runs
}

/** Whether the selection has the cursor, or either end of a selection, in the run or on its edge. */
function touches(selection: Selection, run: LinkRun): boolean {
	const inside = (pos: number) => pos >= run.from && pos <= run.to
	return inside(selection.anchor) || inside(selection.head)
}

/** The runs that get a chip: recognised by the host, and within the body's lookup cap. */
function chipRuns(doc: ProseMirrorNode, host: LinkChipHost): LinkRun[] {
	const lookups = new Set<string>()
	return linkRuns(doc).filter((run) => {
		const target = host.chipFor(run.href)
		if (!target) return false
		if (target.lookup && !lookups.has(target.lookup)) {
			if (lookups.size >= host.maxLookups) return false
			lookups.add(target.lookup)
		}
		return true
	})
}

function chipElement(host: LinkChipHost, run: LinkRun, text: string): HTMLElement {
	const el = document.createElement('span')
	el.className = CHIP_CLASS
	el.dataset.href = run.href
	// A press on the chip must not move the cursor, take focus or start an edit; the click opens
	// the object in a new tab. Both are handled here, before the chip's own link sees them.
	el.addEventListener(
		'mousedown',
		(event) => {
			event.preventDefault()
			event.stopPropagation()
		},
		true,
	)
	el.addEventListener(
		'click',
		(event) => {
			event.preventDefault()
			event.stopPropagation()
			host.open(run.href)
		},
		true,
	)
	host.mount(el, { href: run.href, text })
	return el
}

function compute(
	doc: ProseMirrorNode,
	selection: Selection,
	state: Pick<LinkChipState, 'host' | 'generation' | 'focused'>,
): DecorationSet {
	const { host, generation, focused } = state
	if (!host) return DecorationSet.empty
	const decorations: Decoration[] = []
	const seen = new Map<string, number>()
	for (const run of chipRuns(doc, host)) {
		if (focused && touches(selection, run)) continue
		// The nth chip for an address keeps its element while the text around it is edited.
		const nth = seen.get(run.href) ?? 0
		seen.set(run.href, nth + 1)
		const text = doc.textBetween(run.from, run.to)
		decorations.push(
			Decoration.widget(run.from, () => chipElement(host, run, text), {
				side: -1,
				// Not inside the link mark: the chip carries its own link.
				marks: [],
				key: `${generation}\n${run.href}\n${nth}`,
				ignoreSelection: true,
				stopEvent: () => true,
				destroy: (dom) => host.unmount(dom as HTMLElement),
			}),
			Decoration.inline(run.from, run.to, { class: SOURCE_CLASS, style: 'display: none' }),
		)
	}
	return DecorationSet.create(doc, decorations)
}

/** The link the cursor touches, if it has a chip: what Mod-Enter opens. */
function touchedChipLink(state: EditorState, host: LinkChipHost): LinkRun | null {
	const { selection } = state
	return chipRuns(state.doc, host).find((run) => touches(selection, run)) ?? null
}

/**
 * Tiptap extension that draws link chips. The host is read through a ref so the extension (and
 * with it the editor) stays stable across renders; the editor pushes it in with setLinkChips.
 */
export function createLinkChips(handlers: { current: LinkChipHandlers }) {
	return Extension.create({
		name: 'maskinLinkChips',

		addProseMirrorPlugins() {
			return [
				new Plugin<LinkChipState>({
					key: linkChipsKey,
					state: {
						init: (_config, instance) => {
							const base = { host: handlers.current.host, generation: 0, focused: false }
							return { ...base, decorations: compute(instance.doc, instance.selection, base) }
						},
						apply(tr, value, _oldState, newState) {
							const meta = tr.getMeta(linkChipsKey) as LinkChipMeta | undefined
							if (!meta && !tr.docChanged && !tr.selectionSet) return value
							const host = meta && 'host' in meta ? (meta.host ?? null) : value.host
							const next = {
								host,
								generation: host === value.host ? value.generation : value.generation + 1,
								focused: meta && 'focused' in meta ? Boolean(meta.focused) : value.focused,
							}
							return { ...next, decorations: compute(newState.doc, newState.selection, next) }
						},
					},
					props: {
						decorations: (state) => linkChipsKey.getState(state)?.decorations,
						handleKeyDown: (view, event) => {
							const host = linkChipsKey.getState(view.state)?.host
							if (!host || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return false
							const run = touchedChipLink(view.state, host)
							if (!run) return false
							event.preventDefault()
							host.open(run.href)
							return true
						},
						handleDOMEvents: {
							focus: (view) => {
								setFocused(view, true)
								return false
							},
							blur: (view) => {
								setFocused(view, false)
								return false
							},
						},
					},
				}),
			]
		},
	})
}

/**
 * Focus moves the chips, so tell the plugin. The focus event fires while the click that caused it
 * is still being read, so the redraw waits a frame and carries the selection the page has by then.
 */
function setFocused(view: EditorView, focused: boolean): void {
	const dispatch = () => {
		if (view.isDestroyed) return
		if (linkChipsKey.getState(view.state)?.focused === focused) return
		const tr = view.state.tr.setMeta(linkChipsKey, { focused }).setMeta('addToHistory', false)
		view.dispatch(focused ? withPageSelection(view, tr) : tr)
	}
	if (focused && typeof requestAnimationFrame === 'function') requestAnimationFrame(dispatch)
	else dispatch()
}

/** Hand the editor the host to draw chips with, or null for none. Draws nothing into the document. */
export function setLinkChips(view: EditorView, host: LinkChipHost | null): void {
	const tr = view.state.tr
		.setMeta(linkChipsKey, { host, focused: view.hasFocus() } satisfies LinkChipMeta)
		.setMeta('addToHistory', false)
	view.dispatch(tr)
}
