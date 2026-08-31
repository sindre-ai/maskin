import type { Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react'
import {
	Bold as BoldIcon,
	Code as CodeIcon,
	Heading1,
	Heading2,
	Heading3,
	Italic as ItalicIcon,
	Link as LinkIcon,
	List as ListIcon,
	ListOrdered as ListOrderedIcon,
	type LucideIcon,
	Pilcrow,
	Quote as QuoteIcon,
	Strikethrough,
	Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorVariant } from './editor'

export type ToolbarAction =
	| 'bold'
	| 'italic'
	| 'strike'
	| 'code'
	| 'link'
	| 'unlink'
	| 'paragraph'
	| 'heading_1'
	| 'heading_2'
	| 'heading_3'
	| 'bullet_list'
	| 'ordered_list'
	| 'blockquote'

const MOBILE_BREAKPOINT_PX = 640

/**
 * True while the viewport is at or below 640 CSS px. Local to
 * `packages/markdown` — `apps/web` owns its own mobile hook, but this package
 * cannot depend on `apps/web`. Guards against SSR (`window` undefined) and
 * against jsdom/test envs missing `matchMedia`.
 */
function useIsMobileToolbar(): boolean {
	const [isMobile, setIsMobile] = useState<boolean>(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return false
		return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
	})

	useEffect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return
		const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`)
		const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches)
		setIsMobile(mql.matches)
		mql.addEventListener('change', handler)
		return () => mql.removeEventListener('change', handler)
	}, [])

	return isMobile
}

/**
 * The slash-command menu writes an `active` flag onto `editor.storage.suggestion`
 * (spec §7). The suggestion extension isn't wired yet (Task 2), so this is a
 * defensive read: if the storage bag or key is missing, treat the menu as closed.
 */
function isSlashMenuOpen(editor: Editor): boolean {
	const suggestion = (editor.storage as Record<string, unknown>).suggestion as
		| { active?: boolean }
		| undefined
	return suggestion?.active === true
}

/**
 * Selection endpoints inside a table but straddling a row or cell boundary
 * mean the user is dragging across table structure — the toolbar's inline
 * marks don't apply here, so we hide (spec §7 dismiss rule).
 */
function selectionCrossesTableBoundary(editor: Editor): boolean {
	const { from, to } = editor.state.selection
	if (from === to) return false
	const $from = editor.state.doc.resolve(from)
	const $to = editor.state.doc.resolve(to)
	const fromCell = findAncestor($from, ['tableCell', 'tableHeader'])
	const toCell = findAncestor($to, ['tableCell', 'tableHeader'])
	if (!fromCell && !toCell) return false
	return fromCell !== toCell
}

function findAncestor(
	pos: ReturnType<Editor['state']['doc']['resolve']>,
	names: string[],
): number | null {
	for (let depth = pos.depth; depth >= 0; depth--) {
		const node = pos.node(depth)
		if (names.includes(node.type.name)) return pos.before(depth)
	}
	return null
}

const URL_TEST_RE = /^(https?:\/\/|mailto:|tel:|\/)/i

function looksLikeUrl(candidate: string): boolean {
	return URL_TEST_RE.test(candidate.trim())
}

/**
 * Prefixes a URL-shaped string with `https://` if it looks like a bare host
 * (e.g. `example.com/foo`). Leaves protocol-carrying and relative URLs alone.
 */
function normalizeHref(raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed) return ''
	if (URL_TEST_RE.test(trimmed)) return trimmed
	// Bare host without a scheme — assume https so the resulting link is
	// navigable. Anything without a `.` is probably not a URL at all; leave it.
	if (/\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`
	return trimmed
}

export interface EditorToolbarProps {
	editor: Editor | null
	variant: EditorVariant
	onToolbarAction?: (action: ToolbarAction) => void
	/** Optional class applied to the popover container (desktop) or bar (mobile). */
	className?: string
	/**
	 * Incrementing counter used by the parent editor to force-open the link
	 * popover (e.g. when the user hits `Mod+Shift+K`). Any change from the
	 * previous render opens the popover.
	 */
	openPulse?: number
}

interface ToolbarButtonProps {
	icon: LucideIcon
	label: string
	shortcut?: string
	isActive?: boolean
	onClick: () => void
	'aria-pressed'?: boolean
}

function ToolbarButton({ icon: Icon, label, shortcut, isActive, onClick }: ToolbarButtonProps) {
	const title = shortcut ? `${label} (${shortcut})` : label
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={isActive ? true : undefined}
			title={title}
			className={
				'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 aria-pressed:bg-accent aria-pressed:text-accent-foreground'
			}
			// Prevents the editor from losing selection when the button is
			// pointer-pressed — Tiptap collapses to caret on blur, which would
			// hide the bubble menu before the click handler runs.
			onMouseDown={(event) => event.preventDefault()}
			onClick={onClick}
		>
			<Icon className="h-4 w-4" aria-hidden="true" />
		</button>
	)
}

function Divider() {
	return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
}

interface LinkPopoverProps {
	editor: Editor
	open: boolean
	initialUrl: string
	onCommit: (url: string) => void
	onRemove: () => void
	onClose: () => void
}

function LinkPopover({ editor, open, initialUrl, onCommit, onRemove, onClose }: LinkPopoverProps) {
	const inputRef = useRef<HTMLInputElement | null>(null)
	const [value, setValue] = useState(initialUrl)

	useEffect(() => {
		if (open) {
			setValue(initialUrl)
			// Defer focus until the popover has mounted.
			requestAnimationFrame(() => inputRef.current?.focus())
		}
	}, [open, initialUrl])

	if (!open) return null

	const hasExistingLink = editor.isActive('link')

	const submit = () => {
		const normalized = normalizeHref(value)
		if (!normalized) {
			onRemove()
			return
		}
		onCommit(normalized)
	}

	return (
		<div
			className="flex items-center gap-1 border-t border-border bg-popover p-1.5 sm:absolute sm:left-0 sm:top-full sm:mt-1 sm:w-80 sm:rounded-md sm:border sm:shadow-md"
			data-editor-link-popover
			// Keep the surrounding bubble menu from stealing focus.
			onMouseDown={(event) => event.stopPropagation()}
		>
			<input
				ref={inputRef}
				type="url"
				aria-label="Link URL"
				placeholder="Paste or type a URL"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault()
						submit()
					}
					if (event.key === 'Escape') {
						event.preventDefault()
						onClose()
					}
				}}
				className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<button
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={submit}
				className="inline-flex h-8 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
			>
				{hasExistingLink ? 'Update' : 'Add'}
			</button>
			{hasExistingLink && (
				<button
					type="button"
					aria-label="Remove link"
					title="Remove link"
					onMouseDown={(event) => event.preventDefault()}
					onClick={onRemove}
					className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
				>
					<Trash2 className="h-4 w-4" aria-hidden="true" />
				</button>
			)}
		</div>
	)
}

/**
 * Floating toolbar surfaced on non-empty selection (spec §7). On viewports
 * ≤640px the toolbar renders as a sticky bottom bar; on larger viewports it
 * follows the selection as a floating popover positioned by `tippy.js`
 * (which `@tiptap/extension-bubble-menu` wraps).
 *
 * Only the `document` variant is in scope for this task; other variants pass
 * through as `null` so their toolbar can be added when those variants ship
 * (see [Rich Markdown editor across Maskin](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01)).
 */
export function EditorToolbar({
	editor,
	variant,
	onToolbarAction,
	className,
	openPulse,
}: EditorToolbarProps) {
	const isMobile = useIsMobileToolbar()
	const [linkOpen, setLinkOpen] = useState(false)

	// Force-open the link popover when the parent bumps `openPulse` (e.g. the
	// `Mod+Shift+K` shortcut handler in `editor.tsx`).
	const lastPulseRef = useRef(openPulse ?? 0)
	useEffect(() => {
		if (openPulse === undefined) return
		if (openPulse !== lastPulseRef.current) {
			lastPulseRef.current = openPulse
			setLinkOpen(true)
		}
	}, [openPulse])

	// Close the link popover when the selection collapses / editor blurs.
	useEffect(() => {
		if (!editor) return
		const handler = () => {
			if (editor.state.selection.empty) setLinkOpen(false)
		}
		editor.on('selectionUpdate', handler)
		editor.on('blur', handler)
		return () => {
			editor.off('selectionUpdate', handler)
			editor.off('blur', handler)
		}
	}, [editor])

	// Recomputes on every render, but the LinkPopover only uses it on open
	// (via its own `useEffect([open, initialUrl])`), so the cost is bounded.
	// Not a useMemo — including `linkOpen` in the dep list would be a false
	// positive under the exhaustive-deps rule, since the value isn't read here.
	const linkInitialUrl = (() => {
		if (!editor) return ''
		const existing = editor.getAttributes('link').href as string | undefined
		if (existing) return existing
		const { from, to } = editor.state.selection
		const selected = editor.state.doc.textBetween(from, to, ' ').trim()
		return looksLikeUrl(selected) ? selected : ''
	})()

	const emit = useCallback(
		(action: ToolbarAction) => {
			onToolbarAction?.(action)
		},
		[onToolbarAction],
	)

	const run = useCallback(
		(action: ToolbarAction, command: () => boolean) => {
			if (!editor) return
			const ok = command()
			if (ok) emit(action)
		},
		[editor, emit],
	)

	if (!editor || variant !== 'document') return null

	const shouldShow = ({ editor: e, from, to }: { editor: Editor; from: number; to: number }) => {
		if (from === to) return false
		if (e.isDestroyed) return false
		if (!e.isEditable) return false
		if (!e.isFocused && !linkOpen) return false
		if (isSlashMenuOpen(e)) return false
		if (selectionCrossesTableBoundary(e)) return false
		return true
	}

	const buttons = (
		<>
			<ToolbarButton
				icon={BoldIcon}
				label="Bold"
				shortcut="Mod+B"
				isActive={editor.isActive('bold')}
				onClick={() => run('bold', () => editor.chain().focus().toggleBold().run())}
			/>
			<ToolbarButton
				icon={ItalicIcon}
				label="Italic"
				shortcut="Mod+I"
				isActive={editor.isActive('italic')}
				onClick={() => run('italic', () => editor.chain().focus().toggleItalic().run())}
			/>
			<ToolbarButton
				icon={Strikethrough}
				label="Strikethrough"
				shortcut="Mod+Shift+X"
				isActive={editor.isActive('strike')}
				onClick={() => run('strike', () => editor.chain().focus().toggleStrike().run())}
			/>
			<ToolbarButton
				icon={CodeIcon}
				label="Inline code"
				shortcut="Mod+E"
				isActive={editor.isActive('code')}
				onClick={() => run('code', () => editor.chain().focus().toggleCode().run())}
			/>
			<ToolbarButton
				icon={LinkIcon}
				label="Link"
				shortcut="Mod+Shift+K"
				isActive={editor.isActive('link')}
				onClick={() => {
					emit('link')
					setLinkOpen((open) => !open)
				}}
			/>
			<Divider />
			<ToolbarButton
				icon={Pilcrow}
				label="Paragraph"
				isActive={editor.isActive('paragraph')}
				onClick={() => run('paragraph', () => editor.chain().focus().setParagraph().run())}
			/>
			<ToolbarButton
				icon={Heading1}
				label="Heading 1"
				shortcut="Mod+Alt+1"
				isActive={editor.isActive('heading', { level: 1 })}
				onClick={() =>
					run('heading_1', () => editor.chain().focus().toggleHeading({ level: 1 }).run())
				}
			/>
			<ToolbarButton
				icon={Heading2}
				label="Heading 2"
				shortcut="Mod+Alt+2"
				isActive={editor.isActive('heading', { level: 2 })}
				onClick={() =>
					run('heading_2', () => editor.chain().focus().toggleHeading({ level: 2 }).run())
				}
			/>
			<ToolbarButton
				icon={Heading3}
				label="Heading 3"
				shortcut="Mod+Alt+3"
				isActive={editor.isActive('heading', { level: 3 })}
				onClick={() =>
					run('heading_3', () => editor.chain().focus().toggleHeading({ level: 3 }).run())
				}
			/>
			<Divider />
			<ToolbarButton
				icon={ListIcon}
				label="Bulleted list"
				shortcut="Mod+Shift+8"
				isActive={editor.isActive('bulletList')}
				onClick={() => run('bullet_list', () => editor.chain().focus().toggleBulletList().run())}
			/>
			<ToolbarButton
				icon={ListOrderedIcon}
				label="Numbered list"
				shortcut="Mod+Shift+7"
				isActive={editor.isActive('orderedList')}
				onClick={() => run('ordered_list', () => editor.chain().focus().toggleOrderedList().run())}
			/>
			<ToolbarButton
				icon={QuoteIcon}
				label="Blockquote"
				shortcut="Mod+Shift+B"
				isActive={editor.isActive('blockquote')}
				onClick={() => run('blockquote', () => editor.chain().focus().toggleBlockquote().run())}
			/>
		</>
	)

	const commitLink = (url: string) => {
		if (!url) {
			editor.chain().focus().extendMarkRange('link').unsetLink().run()
			emit('unlink')
		} else {
			editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
			emit('link')
		}
		setLinkOpen(false)
	}

	const removeLink = () => {
		editor.chain().focus().extendMarkRange('link').unsetLink().run()
		emit('unlink')
		setLinkOpen(false)
	}

	if (isMobile) {
		// Sticky bottom bar variant. Renders below the editor viewport-wise,
		// visible whenever there is a non-empty selection or the link popover
		// is open. Sits on the layout so it never obscures selection controls.
		const visible = !editor.state.selection.empty || linkOpen
		if (!visible) return null
		return (
			<div
				data-editor-toolbar="mobile"
				className={
					className ??
					'fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-popover shadow-lg'
				}
				role="toolbar"
				aria-label="Editor formatting"
			>
				<div className="flex items-center gap-0.5 overflow-x-auto p-1.5">{buttons}</div>
				<LinkPopover
					editor={editor}
					open={linkOpen}
					initialUrl={linkInitialUrl}
					onCommit={commitLink}
					onRemove={removeLink}
					onClose={() => setLinkOpen(false)}
				/>
			</div>
		)
	}

	return (
		<BubbleMenu
			editor={editor}
			shouldShow={shouldShow}
			tippyOptions={{
				placement: 'top',
				// tippy uses popper's flip modifier by default; explicitly
				// nominating 'bottom' as the fallback matches spec §7.
				popperOptions: {
					modifiers: [
						{
							name: 'flip',
							options: { fallbackPlacements: ['bottom'] },
						},
					],
				},
			}}
		>
			<div
				data-editor-toolbar="floating"
				className={
					className ?? 'relative flex flex-col rounded-md border border-border bg-popover shadow-md'
				}
				role="toolbar"
				aria-label="Editor formatting"
			>
				<div className="flex items-center gap-0.5 p-1">{buttons}</div>
				<LinkPopover
					editor={editor}
					open={linkOpen}
					initialUrl={linkInitialUrl}
					onCommit={commitLink}
					onRemove={removeLink}
					onClose={() => setLinkOpen(false)}
				/>
			</div>
		</BubbleMenu>
	)
}
