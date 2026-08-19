import { CommentVisual, isVisualLanguage } from '@/components/activity/comment-visual'
import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { splitMarkdownMarkers } from '@/lib/markdown-markers'
import { remarkPlugins } from '@maskin/markdown/plugins'
import {
	Children,
	type ReactElement,
	type ReactNode,
	isValidElement,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { MentionedText } from './mentioned-text'

function wrapWithMentions(
	children: ReactNode,
	actors: ActorListItem[],
	onMentionClick?: (actor: ActorListItem) => void,
): ReactNode {
	if (typeof children === 'string') {
		return <MentionedText content={children} actors={actors} onMentionClick={onMentionClick} />
	}
	if (Array.isArray(children)) {
		const mentionProps = { actors, onMentionClick }
		return children.map((child, idx) =>
			typeof child === 'string' ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: children come from a deterministic markdown AST; order is stable across renders
				<MentionedText key={`m-${idx}`} content={child} {...mentionProps} />
			) : (
				child
			),
		)
	}
	return children
}

/**
 * Extracts the language hint (e.g. "chart") from the `language-X` className
 * react-markdown puts on the inner `<code>` of a fenced block.
 */
function readCodeLanguage(child: ReactNode): string | undefined {
	if (!isValidElement(child)) return undefined
	const childEl = child as ReactElement<{ className?: string }>
	const className = childEl.props?.className
	if (typeof className !== 'string') return undefined
	const match = className.match(/language-([\w-]+)/)
	return match?.[1]
}

function readCodeSource(child: ReactNode): string {
	if (!isValidElement(child)) return ''
	const childEl = child as ReactElement<{ children?: ReactNode }>
	const inner = childEl.props?.children
	if (typeof inner === 'string') return inner
	if (Array.isArray(inner)) return inner.filter((c): c is string => typeof c === 'string').join('')
	return ''
}

/**
 * Toggle a markdown marker around `[start, end)` — `**` for bold, `_` for
 * italic, backtick for code. Wrapping an already-wrapped range unwraps it, so
 * the same shortcut is its own undo (mockup 8493–8506).
 */
export function toggleMarkdownMarker(
	value: string,
	rawStart: number,
	rawEnd: number,
	marker: string,
): { value: string; start: number; end: number } {
	// Markdown will not emphasise a run padded with spaces — `**word **` renders
	// as literal asterisks — and a double-click or a drag routinely picks up the
	// trailing space. Wrap the words, leave the padding outside.
	let start = rawStart
	let end = rawEnd
	while (start < end && /\s/.test(value[start] ?? '')) start += 1
	while (end > start && /\s/.test(value[end - 1] ?? '')) end -= 1
	if (start === end) return { value, start: rawStart, end: rawEnd }

	const before = value.slice(Math.max(0, start - marker.length), start)
	const after = value.slice(end, end + marker.length)
	if (before === marker && after === marker) {
		return {
			value:
				value.slice(0, start - marker.length) +
				value.slice(start, end) +
				value.slice(end + marker.length),
			start: start - marker.length,
			end: end - marker.length,
		}
	}
	return {
		value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end),
		start: start + marker.length,
		end: end + marker.length,
	}
}

/**
 * Where a click in the *rendered* prose lands in the *markdown source*.
 *
 * `nodeText` is the text node the click hit; finding it in the source and
 * adding the offset within it puts the caret under the pointer. Inline markup
 * (`**bold**`, links) shifts the answer by the marker characters, so this is a
 * near-miss rather than an exact map — still far better than the alternative,
 * which is every click landing at character 0. Returns null when the run can't
 * be located, and the caller falls back to the end of the document.
 */
export function caretOffsetInSource(
	source: string,
	nodeText: string,
	offsetInNode: number,
): number | null {
	const probe = nodeText.trim()
	if (probe.length === 0) return null
	const at = source.indexOf(probe)
	if (at < 0) return null
	// The rendered node may carry leading whitespace the source doesn't.
	const lead = nodeText.length - nodeText.trimStart().length
	const within = Math.max(0, Math.min(offsetInNode - lead, probe.length))
	return at + within
}

/** Reads the caret position under a point, across both browser spellings. */
function caretOffsetAtPoint(x: number, y: number, source: string): number | null {
	const doc = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
		caretRangeFromPoint?: (x: number, y: number) => Range | null
	}
	let node: Node | null = null
	let offset = 0
	if (typeof doc.caretPositionFromPoint === 'function') {
		const pos = doc.caretPositionFromPoint(x, y)
		if (pos) {
			node = pos.offsetNode
			offset = pos.offset
		}
	} else if (typeof doc.caretRangeFromPoint === 'function') {
		const range = doc.caretRangeFromPoint(x, y)
		if (range) {
			node = range.startContainer
			offset = range.startOffset
		}
	}
	if (!node || node.nodeType !== Node.TEXT_NODE) return null
	return caretOffsetInSource(source, node.textContent ?? '', offset)
}

/**
 * One line of a markdown list: indent, marker, the space after it, an optional
 * task checkbox, then the item's own text.
 */
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/
/** What one Tab step is worth. Two spaces — the nesting width remark reads. */
const INDENT = '  '

/** A rewritten textarea value plus where the selection should sit after it. */
export interface EditorEdit {
	value: string
	start: number
	end: number
}

/** The lines the selection touches, as a [start, end) slice of `value`. */
function touchedLines(value: string, start: number, end: number): [number, number] {
	const from = value.lastIndexOf('\n', start - 1) + 1
	const nextBreak = value.indexOf('\n', end)
	return [from, nextBreak === -1 ? value.length : nextBreak]
}

/**
 * Enter inside a list carries the marker down to the next line, and Enter on an
 * item that was left empty ends the list instead of laying down another marker
 * — the two behaviours every markdown editor has and a bare textarea doesn't.
 *
 * Returns null when the caret isn't in a list, so Enter falls through to the
 * browser's own newline.
 */
export function continueListOnEnter(value: string, start: number, end: number): EditorEdit | null {
	// A selection replaces its own range; only a collapsed caret continues.
	if (start !== end) return null
	const [lineStart, lineEnd] = touchedLines(value, start, start)
	const match = LIST_LINE.exec(value.slice(lineStart, lineEnd))
	if (!match) return null
	const indent = match[1] ?? ''
	const marker = match[2] ?? ''
	const spacing = match[3] ?? ''
	const checkbox = match[4]
	const body = match[5] ?? ''

	if (body.trim().length === 0) {
		// Drop the marker and leave the caret on the now-blank line.
		return {
			value: value.slice(0, lineStart) + value.slice(start),
			start: lineStart,
			end: lineStart,
		}
	}

	const ordered = /^(\d+)([.)])$/.exec(marker)
	const nextMarker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker
	const inserted = `\n${indent}${nextMarker}${spacing}${checkbox ? '[ ] ' : ''}`
	const caret = start + inserted.length
	return { value: value.slice(0, start) + inserted + value.slice(start), start: caret, end: caret }
}

/**
 * True where Tab means "indent" rather than "leave this field": inside a list
 * item, or across a selection that spans lines. Everywhere else Tab keeps
 * moving focus, so the editor never becomes a keyboard trap.
 */
export function isIndentContext(value: string, start: number, end: number): boolean {
	if (value.slice(start, end).includes('\n')) return true
	const [lineStart, lineEnd] = touchedLines(value, start, start)
	return LIST_LINE.test(value.slice(lineStart, lineEnd))
}

/** Shifts every line the selection touches one step in or out. */
export function shiftIndent(
	value: string,
	start: number,
	end: number,
	outdent: boolean,
): EditorEdit {
	const [blockStart, blockEnd] = touchedLines(value, start, end)
	let firstDelta = 0
	let totalDelta = 0
	const shifted = value
		.slice(blockStart, blockEnd)
		.split('\n')
		.map((line, index) => {
			if (outdent) {
				const removed = /^(?:\t| {1,2})/.exec(line)?.[0] ?? ''
				if (index === 0) firstDelta = -removed.length
				totalDelta -= removed.length
				return line.slice(removed.length)
			}
			// A blank line gets no indent — that would only leave trailing spaces.
			if (line.length === 0) return line
			if (index === 0) firstDelta = INDENT.length
			totalDelta += INDENT.length
			return INDENT + line
		})
		.join('\n')

	return {
		value: value.slice(0, blockStart) + shifted + value.slice(blockEnd),
		start: Math.max(blockStart, start + firstDelta),
		end: Math.max(blockStart, end + totalDelta),
	}
}

/**
 * Maps a character offset in the draft onto a position in the overlay's text
 * nodes. The overlay renders exactly the draft, so the two share an offset
 * space — which is what lets a textarea selection, which has no geometry of
 * its own, borrow the overlay's.
 */
function locateOffset(root: HTMLElement, target: number): { node: Node; offset: number } | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
	let seen = 0
	let node = walker.nextNode()
	while (node) {
		const length = node.textContent?.length ?? 0
		if (seen + length >= target) return { node, offset: target - seen }
		seen += length
		node = walker.nextNode()
	}
	return null
}

/** ⌘B / ⌘I / ⌘E — the three the mockup binds. */
const SHORTCUT_MARKERS: Record<string, string> = { b: '**', i: '_', e: '`' }

interface SelectionToolbarState {
	x: number
	y: number
	text: string
	// Where the selection sits in the markdown *source*. Null when the range
	// couldn't be mapped, and the marker falls back to a first-match search.
	start: number | null
	end: number | null
}

export function MarkdownContent({
	content,
	onChange,
	editable = false,
	className,
	size = 'sm',
	disallowedElements,
	mentionActors,
	onMentionClick,
	renderVisuals = false,
	editorLabel,
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	/** `doc` is the v2 document scale a detail page's body renders at (mockup
	 *  1105–1122): a 15px lead paragraph, 12.5px bold micro-headings, 14px/1.65
	 *  running copy, and em-dash list markers. */
	size?: 'sm' | 'xs' | 'doc'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
	/**
	 * Opt-in: when true, fenced blocks tagged ```chart render as inline visuals
	 * (e.g. recharts). Defaults to false so object-document body markdown is
	 * unaffected — only ActivityComment opts in.
	 */
	renderVisuals?: boolean
	/** Accessible name for the editing field — it has no visible label. */
	editorLabel?: string
}) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(content)
	const containerRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	// Selection an in-progress edit (list continuation, indent, ⌘B) asked for,
	// applied by a layout effect once the new value is on screen.
	const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null)
	// Source offset the caret should take when the editor mounts — set from the
	// click that opened it. Null means "end of the document".
	const pendingCaretRef = useRef<number | null>(null)
	// Height of the rendered prose view at the moment edit mode is entered.
	// Used as a floor so the box doesn't shrink when headings/lists collapse to plain text.
	const [lockedHeight, setLockedHeight] = useState<number | undefined>(undefined)
	// Floating B / I / <> over a highlighted run in the editor (mockup 1030–1035).
	const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null)
	const docOverlayRef = useRef<HTMLDivElement>(null)

	const handleBlur = useCallback(() => {
		setEditing(false)
		if (draft !== content) {
			onChange?.(draft)
		}
	}, [draft, content, onChange])

	const startEditing = (initialDraft: string, caret: number | null = null) => {
		if (containerRef.current) {
			setLockedHeight(containerRef.current.offsetHeight)
		}
		pendingCaretRef.current = caret
		setDraft(initialDraft)
		setEditing(true)
	}

	// The toolbar belongs to the editor: it rises on a highlight inside the
	// field and nowhere else. The textarea has no selection geometry, so the
	// rect comes from the overlay behind it — same metrics, same coordinates.
	const handleEditorSelect = useCallback(() => {
		const ta = textareaRef.current
		const overlay = docOverlayRef.current
		if (!ta || !overlay) return
		const { selectionStart: start, selectionEnd: end } = ta
		if (start === end) {
			setSelectionToolbar(null)
			return
		}
		const from = locateOffset(overlay, start)
		const to = locateOffset(overlay, end)
		if (!from || !to) {
			setSelectionToolbar(null)
			return
		}
		const range = document.createRange()
		range.setStart(from.node, from.offset)
		range.setEnd(to.node, to.offset)
		const rect = range.getBoundingClientRect()
		if (!rect.width && !rect.height) {
			setSelectionToolbar(null)
			return
		}
		setSelectionToolbar({
			x: (rect.left + rect.right) / 2,
			y: rect.top - 8,
			text: ta.value.slice(start, end),
			start,
			end,
		})
	}, [])

	const applyMarkerToSelection = useCallback(
		(marker: string) => {
			const active = selectionToolbar
			setSelectionToolbar(null)
			const ta = textareaRef.current
			// `?? ` not `||` — a selection at offset 0 is a real range.
			if (!active || !ta || active.start === null || active.end === null) return
			const next = toggleMarkdownMarker(ta.value, active.start, active.end, marker)
			setDraft(next.value)
			// Keep the words selected so a second press toggles them back off.
			requestAnimationFrame(() => {
				ta.focus()
				ta.setSelectionRange(next.start, next.end)
			})
		},
		[selectionToolbar],
	)

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current
		if (!ta) return
		ta.style.height = 'auto'
		const scrollHeight = ta.scrollHeight
		const min = lockedHeight ?? 0
		ta.style.height = `${Math.max(scrollHeight, min)}px`
	}, [lockedHeight])

	// Rewrites the field and asks for a caret position once React has committed
	// the new value. Deliberately *not* a requestAnimationFrame callback: a
	// frame can be delayed past the next keystroke, which restores a stale caret
	// mid-word and scatters the characters. The layout effect below runs before
	// paint and before any further input, so the caret can't arrive late.
	const applyEdit = useCallback((edit: EditorEdit) => {
		pendingSelectionRef.current = { start: edit.start, end: edit.end }
		setDraft(edit.value)
	}, [])

	const handleEditorKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				setEditing(false)
				setDraft(content)
				return
			}
			const el = e.currentTarget
			// Tab is claimed only where it means indentation — see isIndentContext.
			if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
				if (!isIndentContext(el.value, el.selectionStart, el.selectionEnd)) return
				e.preventDefault()
				applyEdit(shiftIndent(el.value, el.selectionStart, el.selectionEnd, e.shiftKey))
				return
			}
			if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
				const edit = continueListOnEnter(el.value, el.selectionStart, el.selectionEnd)
				if (!edit) return
				e.preventDefault()
				applyEdit(edit)
				return
			}
			if (!(e.metaKey || e.ctrlKey)) return
			// ⌘⏎ commits, mirroring Escape's revert — otherwise the only way out
			// of a full-page editor is to find something else to click.
			if (e.key === 'Enter') {
				e.preventDefault()
				e.currentTarget.blur()
				return
			}
			const marker = SHORTCUT_MARKERS[e.key.toLowerCase()]
			if (!marker) return
			e.preventDefault()
			applyEdit(toggleMarkdownMarker(el.value, el.selectionStart, el.selectionEnd, marker))
		},
		[content, applyEdit],
	)

	useLayoutEffect(() => {
		if (!editing) return
		adjustHeight()
		const ta = textareaRef.current
		if (!ta || document.activeElement === ta) return
		ta.focus()
		const end = ta.value.length
		ta.setSelectionRange(end, end)
	}, [editing, adjustHeight])

	// Runs after every commit; a no-op unless an edit left a caret request.
	useLayoutEffect(() => {
		const pending = pendingSelectionRef.current
		if (!pending) return
		pendingSelectionRef.current = null
		const ta = textareaRef.current
		if (!ta) return
		ta.setSelectionRange(pending.start, pending.end)
		adjustHeight()
	})

	// Focus is taken here rather than with `autoFocus` so the caret can land
	// where the click did. Keyed on `editing` alone: re-running on a height
	// change would yank the caret back mid-typing.
	useLayoutEffect(() => {
		if (!editing) return
		const ta = textareaRef.current
		if (!ta) return
		ta.focus()
		const caret = Math.min(pendingCaretRef.current ?? ta.value.length, ta.value.length)
		ta.setSelectionRange(caret, caret)
		pendingCaretRef.current = null
	}, [editing])

	// The toolbar is pinned to viewport coordinates captured at selection time,
	// so it detaches from its text the moment anything scrolls. Dismiss instead
	// of leaving it floating over unrelated content.
	useEffect(() => {
		if (!selectionToolbar) return
		const dismiss = () => setSelectionToolbar(null)
		window.addEventListener('scroll', dismiss, true)
		window.addEventListener('resize', dismiss)
		return () => {
			window.removeEventListener('scroll', dismiss, true)
			window.removeEventListener('resize', dismiss)
		}
	}, [selectionToolbar])

	const components = useMemo<Components>(() => {
		// Inline code spans that contain a bare URL render as a clickable link instead
		// of styled monospace — agents commonly write URLs in backticks and the
		// remark-breaks + remark-gfm combination doesn't always autolink them.
		const code: Components['code'] = ({ children, className }) => {
			if (!className) {
				const text = typeof children === 'string' ? children.trim() : ''
				if (!text.includes('\n') && /^https?:\/\/\S+$/.test(text)) {
					return (
						<a href={text} target="_blank" rel="noopener noreferrer">
							{text}
						</a>
					)
				}
			}
			return <code className={className}>{children}</code>
		}

		// When renderVisuals is on, override <pre> (not just <code>) so the
		// dispatched visual replaces the whole block — react-markdown wraps fenced
		// blocks as <pre><code class="language-X">…</code></pre> and a <div>
		// child inside <pre> is invalid HTML.
		const pre: Components['pre'] = ({ children, ...rest }) => {
			if (renderVisuals) {
				const first = Children.toArray(children).find((c) => isValidElement(c)) as
					| ReactElement
					| undefined
				const lang = readCodeLanguage(first)
				if (lang && isVisualLanguage(lang)) {
					return <CommentVisual language={lang} source={readCodeSource(first)} />
				}
			}
			return <pre {...rest}>{children}</pre>
		}

		if (!mentionActors) return { code, pre }
		const wrap = (children: ReactNode) => wrapWithMentions(children, mentionActors, onMentionClick)
		return {
			code,
			pre,
			p: ({ children }) => <p>{wrap(children)}</p>,
			li: ({ children }) => <li>{wrap(children)}</li>,
			em: ({ children }) => <em>{wrap(children)}</em>,
			strong: ({ children }) => <strong>{wrap(children)}</strong>,
			blockquote: ({ children }) => <blockquote>{wrap(children)}</blockquote>,
			del: ({ children }) => <del>{wrap(children)}</del>,
			a: ({ children, ...rest }) => <a {...rest}>{wrap(children)}</a>,
			td: ({ children, ...rest }) => <td {...rest}>{wrap(children)}</td>,
			th: ({ children, ...rest }) => <th {...rest}>{wrap(children)}</th>,
		}
	}, [mentionActors, onMentionClick, renderVisuals])

	if (editable && editing) {
		const isDoc = size === 'doc'
		// The primitive sets `md:text-sm` and a focus ring. At the document scale
		// both have to go, or the copy shrinks a pixel and a stray ring appears
		// the moment you click in — the field has to *be* the view, exactly.
		const field = (
			<Textarea
				ref={textareaRef}
				aria-label={editorLabel}
				className={cn(
					'w-full resize-none overflow-hidden border-none font-sans outline-none focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
					isDoc
						? 'relative min-h-0 rounded-[9px] bg-transparent px-2 py-1 text-[15px] text-transparent caret-foreground md:text-[15px]'
						: 'bg-transparent p-0 text-sm text-muted-foreground',
				)}
				style={{ minHeight: lockedHeight, lineHeight: isDoc ? '1.65' : '1.7142857' }}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value)
					adjustHeight()
				}}
				onKeyDown={handleEditorKeyDown}
				onSelect={isDoc ? handleEditorSelect : undefined}
				onBlur={(e) => {
					// A toolbar press blurs the field; its own mousedown re-focuses, so
					// only a blur to somewhere else should commit and dismiss.
					if (e.relatedTarget?.closest('[data-selection-toolbar]')) return
					setSelectionToolbar(null)
					handleBlur()
				}}
			/>
		)

		if (!isDoc) return field

		return (
			<div className="-ml-2 flex w-[calc(100%+8px)] max-w-[75ch] flex-col">
				{/* Fixed over the highlighted run. The buttons act on mousedown so
				    the browser never clears the selection first, and the field's
				    blur handler ignores a blur that lands on them. */}
				{selectionToolbar && (
					<div
						data-selection-toolbar=""
						className="fixed z-[60] flex -translate-x-1/2 -translate-y-full gap-0.5 rounded-[9px] bg-primary p-[3px] shadow-lg"
						style={{ left: selectionToolbar.x, top: selectionToolbar.y }}
					>
						{(
							[
								{ marker: '**', label: 'Bold', glyph: 'B', className: 'font-extrabold' },
								{ marker: '_', label: 'Italic', glyph: 'I', className: 'font-semibold italic' },
								{
									marker: '`',
									label: 'Code',
									glyph: '<>',
									className: 'font-mono text-[11px] font-semibold',
								},
							] as const
						).map((action) => (
							<button
								key={action.label}
								type="button"
								title={action.label}
								aria-label={action.label}
								onMouseDown={(e) => {
									e.preventDefault()
									applyMarkerToSelection(action.marker)
								}}
								className={cn(
									'grid size-[26px] place-items-center rounded-[7px] text-[12.5px] text-primary-foreground transition-colors hover:bg-secondary-foreground/25',
									action.className,
								)}
							>
								{action.glyph}
							</button>
						))}
					</div>
				)}

				{/* What you read is the overlay; the textarea over it is transparent
				    but for its caret. Same font, size, leading, padding and wrapping,
				    so every glyph lands in the same place — which is what lets the
				    delimiters recede without the caret drifting off the text. */}
				<div className="relative rounded-[9px] bg-muted/60 ring-1 ring-border">
					<div
						ref={docOverlayRef}
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-2 py-1 text-[15px] leading-[1.65] text-foreground"
					>
						{splitMarkdownMarkers(draft).map((segment, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional by construction
								key={index}
								className={cn(segment.isMarker && 'text-border-strong')}
							>
								{segment.text}
							</span>
						))}
						{/* Keeps the overlay's height in step when the draft ends in a newline. */}
						{draft.endsWith('\n') && '\u200b'}
					</div>
					{field}
				</div>
				<p className="mt-1.5 px-2 text-[10.5px] text-muted-foreground">
					<kbd className="font-mono">Esc</kbd> to cancel · <kbd className="font-mono">⌘↵</kbd> to
					save · <kbd className="font-mono">⌘B</kbd> <kbd className="font-mono">⌘I</kbd>{' '}
					<kbd className="font-mono">⌘E</kbd> to format
				</p>
			</div>
		)
	}

	if (editable && !content) {
		return (
			<Textarea
				aria-label={editorLabel}
				className={`${className ?? ''} w-full min-h-[60px] text-sm text-muted-foreground`}
				placeholder="Click to add content..."
				onFocus={() => startEditing('')}
				readOnly
			/>
		)
	}

	return (
		<>
			<div
				ref={containerRef}
				className={cn(
					className,
					// The doc view sits on the editor's own plate and measure, so the
					// swap into edit mode moves nothing (mockup 1027–1037).
					size === 'doc' &&
						editable &&
						'-ml-2 w-[calc(100%+8px)] max-w-[75ch] cursor-text rounded-[9px] px-2 py-1 transition-colors hover:bg-muted/60',
				)}
				onClick={(e) => {
					if (!editable) return
					// Links, task checkboxes and any other control in the body have to
					// keep working — swallowing their click into the editor makes the
					// rendered document unusable as a document.
					if (
						(e.target as HTMLElement).closest(
							'a,button,input,select,textarea,summary,[role="button"]',
						)
					) {
						return
					}
					// Selecting text must not drop you into the editor and lose it.
					if (String(window.getSelection() ?? '').trim()) return
					startEditing(content, caretOffsetAtPoint(e.clientX, e.clientY, content))
				}}
				onKeyDown={(e) => {
					if (editable && (e.key === 'Enter' || e.key === ' ')) startEditing(content)
				}}
				tabIndex={editable ? 0 : undefined}
			>
				<div
					className={cn(
						'prose dark:prose-invert prose-sm max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-p:leading-[1.7142857] prose-li:text-muted-foreground prose-a:text-primary prose-strong:text-foreground prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded',
						'break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_img]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full',
						size === 'xs' && '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs',
						size === 'doc' && [
							'[&_p]:text-[15px] [&_p]:leading-[1.65] [&_p]:text-foreground [&_p]:mb-2 [&_p]:mt-0',
							'[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px] [&_h4]:text-[13px]',
							'[&_:is(h1,h2,h3,h4)]:font-bold [&_:is(h1,h2,h3,h4)]:tracking-[-0.01em] [&_:is(h1,h2,h3,h4)]:mb-1 [&_:is(h1,h2,h3,h4)]:mt-3.5',
							'[&_li]:text-sm [&_li]:leading-[1.6] [&_li]:text-foreground [&_li]:my-0',
							"[&_ul]:list-none [&_ul]:pl-0 [&_ul]:my-0 [&_ul]:mb-2.5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-[5px] [&_ul>li]:relative [&_ul>li]:pl-[22px] [&_ul>li]:before:absolute [&_ul>li]:before:left-0 [&_ul>li]:before:text-border-strong [&_ul>li]:before:content-['—']",
						],
					)}
				>
					<ReactMarkdown
						remarkPlugins={remarkPlugins as unknown as never[]}
						disallowedElements={disallowedElements}
						unwrapDisallowed={Boolean(disallowedElements && disallowedElements.length > 0)}
						components={components}
					>
						{content}
					</ReactMarkdown>
				</div>
			</div>
		</>
	)
}
