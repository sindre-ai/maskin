import type { Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react'
import {
	Bold as BoldIcon,
	Code as CodeIcon,
	Italic as ItalicIcon,
	Link as LinkIcon,
	type LucideIcon,
	Slash as SlashIcon,
	Strikethrough,
	Trash2,
} from 'lucide-react'
import {
	type KeyboardEvent,
	type FocusEvent as ReactFocusEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react'
import type { EditorVariant } from './editor'

export type ToolbarAction = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'unlink' | 'slash'

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
 * (spec §7). The suggestion extension is wired by a sibling task, so this is a
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

/**
 * The slash menu only opens on a "/" at the start of a block or after
 * whitespace, so a caret that sits right after a word needs a space first.
 */
function slashTrigger(editor: Editor): string {
	const { $from } = editor.state.selection
	if ($from.parentOffset === 0) return '/'
	const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, '\n', '\n')
	return /\s/.test(before) ? '/' : ' /'
}

const URL_TEST_RE = /^(https?:\/\/|mailto:|tel:|\/)/i
const BARE_HOST_RE = /^[^\s/]+\.[a-z]{2,}(?:[/?#]\S*)?$/i

function looksLikeUrl(candidate: string): boolean {
	const trimmed = candidate.trim()
	return URL_TEST_RE.test(trimmed) || BARE_HOST_RE.test(trimmed)
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
	/**
	 * Incrementing counter used by the parent editor to move keyboard focus
	 * into the toolbar (`Alt+F10`). Any change from the previous render
	 * focuses the first toolbar button.
	 */
	focusPulse?: number
}

interface ToolbarButtonProps {
	icon: LucideIcon
	label: string
	shortcut?: string
	isActive?: boolean
	onClick: () => void
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
 * Pixels between the layout viewport's bottom edge and the visual viewport's
 * bottom edge — i.e. the height of the on-screen keyboard while it is open.
 * Anchors the mobile bar above the keyboard (design spec Responsive). Falls
 * back to 0 where `window.visualViewport` is missing.
 */
function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0)

	useEffect(() => {
		if (!enabled || typeof window === 'undefined' || !window.visualViewport) {
			setInset(0)
			return
		}
		const viewport = window.visualViewport
		const update = () => {
			setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
		}
		update()
		viewport.addEventListener('resize', update)
		viewport.addEventListener('scroll', update)
		return () => {
			viewport.removeEventListener('resize', update)
			viewport.removeEventListener('scroll', update)
		}
	}, [enabled])

	return inset
}

/**
 * Selection toolbar for the `document` variant (spec §7): five marks only.
 * Blocks go through the slash menu, not the toolbar (v3 mockup decisions).
 *
 * Above 640px it follows the selection as a floating popover positioned by
 * `tippy.js` (which `@tiptap/extension-bubble-menu` wraps). At 640px and
 * below a sticky format bar replaces it, anchored above the on-screen keyboard
 * and visible whenever the editor is focused. The bar also hosts a slash
 * button that types `/` at the caret, which opens the slash menu.
 *
 * Only the `document` variant is in scope; other variants render `null` until
 * those variants ship (see [Rich Markdown editor across Maskin](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/666e3c4a-953a-4f57-b4a3-de6876b4bc01)).
 */
export function EditorToolbar({
	editor,
	variant,
	onToolbarAction,
	className,
	openPulse,
	focusPulse,
}: EditorToolbarProps) {
	const isMobile = useIsMobileToolbar()
	const keyboardInset = useKeyboardInset(isMobile)
	const [linkOpen, setLinkOpen] = useState(false)
	const [editorFocused, setEditorFocused] = useState(false)
	const toolbarRef = useRef<HTMLDivElement | null>(null)
	// True while focus sits inside the toolbar (Alt+F10, Tab). The editor is
	// blurred at that point, but the toolbar must stay up. The ref feeds the
	// bubble menu's shouldShow, the state re-renders the mobile bar.
	const [toolbarFocused, setToolbarFocused] = useState(false)
	const toolbarFocusedRef = useRef(false)
	const setToolbarFocus = (focused: boolean) => {
		toolbarFocusedRef.current = focused
		setToolbarFocused(focused)
	}

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

	// Move focus into the toolbar when the parent bumps `focusPulse`
	// (`Alt+F10`). The toolbar is already mounted: the shortcut only fires
	// while a selection is active.
	const lastFocusPulseRef = useRef(focusPulse ?? 0)
	useEffect(() => {
		if (focusPulse === undefined) return
		if (focusPulse !== lastFocusPulseRef.current) {
			lastFocusPulseRef.current = focusPulse
			toolbarRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
		}
	}, [focusPulse])

	// Close the link popover when the selection collapses / editor blurs, and
	// track editor focus for the mobile bar.
	useEffect(() => {
		if (!editor) return
		setEditorFocused(editor.isFocused)
		const onSelection = () => {
			if (editor.state.selection.empty) setLinkOpen(false)
		}
		const onFocus = () => setEditorFocused(true)
		const onBlur = ({ event }: { event: FocusEvent }) => {
			// Focus moving into the toolbar (Alt+F10, Tab) is not a real blur.
			if (toolbarRef.current?.contains(event.relatedTarget as Node | null)) return
			setEditorFocused(false)
			onSelection()
		}
		editor.on('selectionUpdate', onSelection)
		editor.on('focus', onFocus)
		editor.on('blur', onBlur)
		return () => {
			editor.off('selectionUpdate', onSelection)
			editor.off('focus', onFocus)
			editor.off('blur', onBlur)
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

	// @tiptap/react registers the BubbleMenu plugin once per editor, so
	// shouldShow must be stable and read live values through refs.
	const isMobileRef = useRef(isMobile)
	isMobileRef.current = isMobile
	const linkOpenRef = useRef(linkOpen)
	linkOpenRef.current = linkOpen
	// Crossing the breakpoint makes the bubble menu re-run shouldShow now
	// instead of on the next selection change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: isMobile is the trigger, not a value read in the body
	useEffect(() => {
		if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr)
	}, [editor, isMobile])
	const shouldShow = useCallback(
		({ editor: e, from, to }: { editor: Editor; from: number; to: number }) => {
			if (isMobileRef.current) return false
			if (from === to) return false
			if (e.isDestroyed) return false
			if (!e.isEditable) return false
			if (!e.isFocused && !linkOpenRef.current && !toolbarFocusedRef.current) return false
			if (isSlashMenuOpen(e)) return false
			if (selectionCrossesTableBoundary(e)) return false
			return true
		},
		[],
	)

	if (!editor || variant !== 'document') return null

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

	// Left/Right move between buttons, Escape hands focus back to the editor
	// (selection intact). Tab and Shift+Tab work natively.
	const handleToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target instanceof HTMLInputElement) return
		if (event.key === 'Escape') {
			event.preventDefault()
			editor.commands.focus()
			return
		}
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
		const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
		const current = items.indexOf(document.activeElement as HTMLButtonElement)
		if (current === -1) return
		event.preventDefault()
		const step = event.key === 'ArrowRight' ? 1 : -1
		items[(current + step + items.length) % items.length]?.focus()
	}

	const toolbarFocusHandlers = {
		onFocus: () => setToolbarFocus(true),
		onBlur: (event: ReactFocusEvent<HTMLDivElement>) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
				setToolbarFocus(false)
			}
		},
		onKeyDown: handleToolbarKeyDown,
	}

	// Sticky format bar. Replaces the floating menu at 640px and below, stays
	// up while the editor is focused (a selection-only bar vanishes on tap and
	// fights the keyboard) and rides above the on-screen keyboard.
	const mobileVisible =
		isMobile && editor.isEditable && (editorFocused || linkOpen || toolbarFocused)

	// The BubbleMenu stays mounted on both sides of the 640px breakpoint and is
	// only switched off on mobile (shouldShow false, no children). Unmounting
	// it while tippy holds its element crashes React with a removeChild error
	// when the viewport is resized or rotated across the breakpoint.
	return (
		<>
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
				{!isMobile && (
					<div
						ref={toolbarRef}
						data-editor-toolbar="floating"
						className={
							className ??
							'relative flex flex-col rounded-md border border-border bg-popover shadow-md'
						}
						role="toolbar"
						aria-label="Editor formatting"
						{...toolbarFocusHandlers}
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
				)}
			</BubbleMenu>
			{mobileVisible && (
				<div
					ref={toolbarRef}
					data-editor-toolbar="mobile"
					className={
						className ??
						'fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-popover shadow-lg'
					}
					style={{ bottom: keyboardInset }}
					role="toolbar"
					aria-label="Editor formatting"
					{...toolbarFocusHandlers}
				>
					<div className="flex items-center gap-0.5 overflow-x-auto p-1.5">
						{buttons}
						<ToolbarButton
							icon={SlashIcon}
							label="Insert block"
							shortcut="/"
							onClick={() =>
								run('slash', () => editor.chain().focus().insertContent(slashTrigger(editor)).run())
							}
						/>
					</div>
					<LinkPopover
						editor={editor}
						open={linkOpen}
						initialUrl={linkInitialUrl}
						onCommit={commitLink}
						onRemove={removeLink}
						onClose={() => setLinkOpen(false)}
					/>
				</div>
			)}
		</>
	)
}
