import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ZERO_WIDTH_SPACE, htmlToMarkdown } from '@/lib/html-to-markdown'
import { applyMarkdownInputRules } from '@/lib/markdown-input-rules'
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
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

// Places a node at the current cursor position, replacing any active selection.
// Shared by paste and Enter-key handling so both go through one deterministic path
// instead of relying on browser-inconsistent contentEditable default behavior.
function insertNodeAtCursor(node: Node) {
	const selection = window.getSelection()
	if (!selection || selection.rangeCount === 0) return
	const range = selection.getRangeAt(0)
	range.deleteContents()
	range.insertNode(node)

	// Range.insertNode() splits a Text-node boundary point even when it's
	// exactly at the end, leaving a stray empty Text node as node's next
	// sibling. Left in place, markdown-input-rules.ts's findLineStart() sees it
	// as "something follows on this line" and defers a legitimate block-level
	// conversion (e.g. typing "- " right after this <br>) — verified via manual
	// browser testing.
	if (node.nextSibling?.nodeType === Node.TEXT_NODE && node.nextSibling.textContent === '') {
		node.nextSibling.remove()
	}

	if (node.nodeType === Node.TEXT_NODE) {
		const length = (node as Text).length
		range.setStart(node, length)
		range.setEnd(node, length)
	} else {
		// A collapsed selection at the parent-boundary right after a void/element
		// node (e.g. <br>, which can't host a caret directly) isn't a reliable
		// target for further *native* typing in Chrome — verified in the real
		// browser, where the next keystrokes landed *before* the inserted node
		// instead of after it. A real trailing text node anchors the caret
		// properly; same fix as the block/inline conversions in
		// markdown-input-rules.ts.
		const anchor = document.createTextNode(ZERO_WIDTH_SPACE)
		node.parentNode?.insertBefore(anchor, node.nextSibling)
		range.setStart(anchor, anchor.length)
		range.setEnd(anchor, anchor.length)
	}

	selection.removeAllRanges()
	selection.addRange(range)
}

// A collapsed Range at (container, container.childNodes.length) — e.g. from
// `range.selectNodeContents(container); range.collapse(false)` — is a position
// *after* container's last child element, not inside it. insertNode() on that
// range would then insert as a sibling of the last child (e.g. after a <p>)
// instead of at the end of its text. Descending to the true last leaf node
// keeps insertions (Enter, paste) landing inside the actual content.
function rangeAtEnd(container: Node): Range {
	let node = container
	while (node.lastChild) node = node.lastChild
	const range = document.createRange()
	if (node.nodeType === Node.TEXT_NODE) {
		const length = node.textContent?.length ?? 0
		range.setStart(node, length)
		range.setEnd(node, length)
	} else {
		range.selectNodeContents(node)
		range.collapse(false)
	}
	return range
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
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
}) {
	const [editing, setEditing] = useState(false)
	// Rendered once when editing starts (see startEditing) and never updated per
	// keystroke. Because the string stays referentially the same while editing,
	// React skips writing dangerouslySetInnerHTML on later re-renders, leaving the
	// live-edited DOM (and cursor/selection) undisturbed.
	const [editingHtml, setEditingHtml] = useState('')
	const editableRef = useRef<HTMLDivElement>(null)
	// Set by the onInput handler; guards against firing onChange when the user
	// merely clicked in and back out without changing anything (a bare HTML->MD
	// round-trip isn't guaranteed to be byte-identical to the original markdown).
	const dirtyRef = useRef(false)
	// Paste's primary path (execCommand('insertText')) fires a real native
	// 'input' event; its manual Range-based fallback doesn't. Without this,
	// pasting text ending in a trigger pattern (e.g. "...**bold**") would
	// inconsistently convert depending on which paste path the browser took —
	// pasted content is intentionally never live-converted.
	const suppressNextInputRuleRef = useRef(false)

	const unwrapDisallowed = Boolean(disallowedElements && disallowedElements.length > 0)

	const codeComponent = useMemo<NonNullable<Components['code']>>(() => {
		// Inline code spans that contain a bare URL render as a clickable link instead
		// of styled monospace — agents commonly write URLs in backticks and the
		// remark-breaks + remark-gfm combination doesn't always autolink them.
		return ({ children, className }) => {
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
	}, [])

	const components = useMemo<Components>(() => {
		if (!mentionActors) return { code: codeComponent }
		const wrap = (children: ReactNode) => wrapWithMentions(children, mentionActors, onMentionClick)
		return {
			code: codeComponent,
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
	}, [mentionActors, onMentionClick, codeComponent])

	// Static markup for edit mode intentionally omits mention wrapping: MentionedText
	// fragments text nodes, which breaks once contentEditable starts mutating the
	// live DOM. Mentions render as plain text while editing and become chips again
	// once back in view mode.
	const buildEditableHtml = useCallback(
		(markdown: string) =>
			renderToStaticMarkup(
				<ReactMarkdown
					remarkPlugins={[remarkGfm, remarkBreaks]}
					disallowedElements={disallowedElements}
					unwrapDisallowed={unwrapDisallowed}
					components={{ code: codeComponent }}
				>
					{markdown}
				</ReactMarkdown>,
			),
		[disallowedElements, unwrapDisallowed, codeComponent],
	)

	const startEditing = (initialDraft: string) => {
		dirtyRef.current = false
		setEditingHtml(buildEditableHtml(initialDraft))
		setEditing(true)
	}

	const handleBlur = useCallback(() => {
		setEditing(false)
		if (!dirtyRef.current) return
		const html = editableRef.current?.innerHTML ?? ''
		const markdown = htmlToMarkdown(html)
		if (markdown !== content) onChange?.(markdown)
	}, [content, onChange])

	const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
		dirtyRef.current = true
		// Skip transform detection mid-IME-composition (CJK input) — running DOM
		// surgery mid-composition risks corrupting partially-composed text.
		if ((e.nativeEvent as InputEvent).isComposing) return
		if (suppressNextInputRuleRef.current) {
			suppressNextInputRuleRef.current = false
			return
		}
		// Runs reactively after the browser has already inserted the typed
		// text — converts a just-completed markdown trigger (e.g. "**bold**",
		// "# ") into real formatting. No-ops when nothing matches.
		if (editableRef.current) applyMarkdownInputRules(editableRef.current)
	}, [])

	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
		e.preventDefault()
		const text = e.clipboardData.getData('text/plain')
		if (!text) return
		dirtyRef.current = true
		suppressNextInputRuleRef.current = true
		const inserted =
			typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
		if (!inserted) {
			// The manual fallback never fires a native 'input' event, so nothing
			// will consume the suppression flag — reset it immediately rather
			// than leaving it stuck true and wrongly suppressing the next
			// legitimate keystroke's conversion.
			suppressNextInputRuleRef.current = false
			insertNodeAtCursor(document.createTextNode(text))
		}
	}, [])

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Enter') return
		e.preventDefault()
		dirtyRef.current = true
		// Force a flat <br> on every Enter press so line breaks deterministically
		// round-trip through the custom turndown rule — browsers otherwise disagree
		// on whether Enter inserts <br>, <div>, or <p>. No new paragraph blocks via
		// keyboard mid-edit in this iteration.
		//
		// Deliberately never uses document.execCommand('insertLineBreak') here:
		// verified in real Chrome that it inserts *two* <br> elements per Enter
		// press (a known trailing-<br>-needs-a-companion quirk), not one — always
		// going through our own manual, deterministic insertion avoids it.
		insertNodeAtCursor(document.createElement('br'))
	}, [])

	// Focus (and place the caret at the end) whenever edit mode is entered.
	useLayoutEffect(() => {
		if (!editing) return
		const el = editableRef.current
		if (!el) return
		el.focus()
		const range = rangeAtEnd(el)
		const selection = window.getSelection()
		selection?.removeAllRanges()
		selection?.addRange(range)
	}, [editing])

	const proseClassName = useMemo(
		() =>
			cn(
				'prose dark:prose-invert prose-sm max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-p:leading-[1.7142857] prose-li:text-muted-foreground prose-a:text-primary prose-strong:text-foreground prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded',
				'break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_img]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full',
				size === 'xs' && '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs',
			),
		[size],
	)

	// React diffs dangerouslySetInnerHTML by object reference, not by the nested
	// __html string — an inline `{ __html: editingHtml }` literal would be a new
	// object every render and force a DOM rewrite on every unrelated re-render,
	// defeating the whole point of only setting innerHTML once. Memoizing on
	// editingHtml keeps the reference stable so React skips the write whenever
	// editingHtml itself hasn't changed.
	const editableHtmlProp = useMemo(() => ({ __html: editingHtml }), [editingHtml])

	if (editable && editing) {
		return (
			<div className={className}>
				<div
					ref={editableRef}
					className={cn(proseClassName, 'outline-none')}
					contentEditable
					suppressContentEditableWarning
					role="textbox"
					aria-multiline="true"
					tabIndex={0}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: editingHtml is our own renderToStaticMarkup output of the same markdown ReactMarkdown already renders in view mode, not raw user HTML
					dangerouslySetInnerHTML={editableHtmlProp}
					onInput={handleInput}
					onBlur={handleBlur}
					onPaste={handlePaste}
					onKeyDown={handleKeyDown}
				/>
			</div>
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
		<div
			className={className}
			onClick={() => {
				if (editable) startEditing(content)
			}}
			onKeyDown={(e) => {
				if (editable && (e.key === 'Enter' || e.key === ' ')) startEditing(content)
			}}
			tabIndex={editable ? 0 : undefined}
		>
			<div className={proseClassName}>
				<ReactMarkdown
					remarkPlugins={[remarkGfm, remarkBreaks]}
					disallowedElements={disallowedElements}
					unwrapDisallowed={unwrapDisallowed}
					components={components}
				>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	)
}
