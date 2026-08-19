import { CommentVisual, isVisualLanguage } from '@/components/activity/comment-visual'
import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { remarkPlugins } from '@maskin/markdown/plugins'
import {
	Children,
	type ReactElement,
	type ReactNode,
	isValidElement,
	useCallback,
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
	start: number,
	end: number,
	marker: string,
): { value: string; start: number; end: number } {
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

/** ⌘B / ⌘I / ⌘E — the three the mockup binds. */
const SHORTCUT_MARKERS: Record<string, string> = { b: '**', i: '_', e: '`' }

interface SelectionToolbarState {
	x: number
	y: number
	text: string
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
}) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(content)
	const containerRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	// Height of the rendered prose view at the moment edit mode is entered.
	// Used as a floor so the box doesn't shrink when headings/lists collapse to plain text.
	const [lockedHeight, setLockedHeight] = useState<number | undefined>(undefined)
	// Floating B / I / <> over a selection in the rendered view (mockup 1030–1035).
	const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null)

	const handleBlur = useCallback(() => {
		setEditing(false)
		if (draft !== content) {
			onChange?.(draft)
		}
	}, [draft, content, onChange])

	const startEditing = (initialDraft: string) => {
		if (containerRef.current) {
			setLockedHeight(containerRef.current.offsetHeight)
		}
		setDraft(initialDraft)
		setEditing(true)
	}

	// A selection in the view arms the toolbar; clicking away or selecting
	// nothing disarms it.
	const handleSelectionUp = useCallback(() => {
		if (!editable) return
		window.setTimeout(() => {
			const selection = window.getSelection()
			const text = selection ? String(selection).trim() : ''
			if (!text || !selection?.rangeCount) {
				setSelectionToolbar(null)
				return
			}
			const rect = selection.getRangeAt(0).getBoundingClientRect()
			setSelectionToolbar({ x: (rect.left + rect.right) / 2, y: rect.top - 8, text })
		}, 0)
	}, [editable])

	// The toolbar edits the markdown source, not the rendered output: it finds
	// the selected text in the source and toggles the marker around it.
	const applyMarkerToSelection = useCallback(
		(marker: string) => {
			const active = selectionToolbar
			setSelectionToolbar(null)
			if (!active) return
			const index = content.indexOf(active.text)
			if (index < 0) return
			const next = toggleMarkdownMarker(content, index, index + active.text.length, marker)
			window.getSelection()?.removeAllRanges()
			if (next.value !== content) onChange?.(next.value)
		},
		[selectionToolbar, content, onChange],
	)

	const handleEditorKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				setEditing(false)
				setDraft(content)
				return
			}
			if (!(e.metaKey || e.ctrlKey)) return
			const marker = SHORTCUT_MARKERS[e.key.toLowerCase()]
			if (!marker) return
			e.preventDefault()
			const el = e.currentTarget
			const next = toggleMarkdownMarker(el.value, el.selectionStart, el.selectionEnd, marker)
			setDraft(next.value)
			requestAnimationFrame(() => {
				el.setSelectionRange(next.start, next.end)
			})
		},
		[content],
	)

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current
		if (!ta) return
		ta.style.height = 'auto'
		const scrollHeight = ta.scrollHeight
		const min = lockedHeight ?? 0
		ta.style.height = `${Math.max(scrollHeight, min)}px`
	}, [lockedHeight])

	useLayoutEffect(() => {
		if (editing) adjustHeight()
	}, [editing, adjustHeight])

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
		return (
			<Textarea
				ref={textareaRef}
				// At the document scale the field is the view: same type, same
				// measure, same plate, so nothing shifts when you start typing.
				className={cn(
					'w-full resize-none overflow-hidden border-none font-sans outline-none focus:outline-none',
					size === 'doc'
						? 'max-w-[75ch] rounded-[9px] bg-muted/60 px-2 py-1 text-[15px] text-foreground'
						: 'bg-transparent p-0 text-sm text-muted-foreground',
				)}
				style={{ minHeight: lockedHeight, lineHeight: size === 'doc' ? '1.65' : '1.7142857' }}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value)
					adjustHeight()
				}}
				onKeyDown={handleEditorKeyDown}
				onBlur={handleBlur}
				autoFocus
			/>
		)
	}

	if (editable && !content) {
		return (
			<Textarea
				className={`${className ?? ''} w-full min-h-[60px] text-sm text-muted-foreground`}
				placeholder="Click to add content..."
				onFocus={() => startEditing('')}
				readOnly
			/>
		)
	}

	return (
		<>
			{/* Fixed to the selection, above it (mockup 1030–1035). The buttons act
			    on mousedown so the browser never clears the selection first. */}
			{selectionToolbar && (
				<div
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
			<div
				ref={containerRef}
				className={className}
				onMouseUp={handleSelectionUp}
				onClick={() => {
					// Selecting text must not drop you into the editor and lose it.
					if (!editable || String(window.getSelection() ?? '').trim()) return
					startEditing(content)
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
