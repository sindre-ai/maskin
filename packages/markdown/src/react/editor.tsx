import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Extensions } from '@tiptap/react'
import { EditorContent, useEditor } from '@tiptap/react'
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	type CommentHighlightHandlers,
	type TextCommentHighlight,
	createCommentHighlights,
	setTextComments,
	textCommentRange,
} from '../comment-highlights'
import { editorMarkdownIt, nodeFeatures, serializeTopLevelBlocks } from '../editor-blocks'
import { type EditorDisallowedNode, type EditorVariant, buildExtensions } from '../extensions'
import {
	type LinkChipHandlers,
	type LinkChipHost,
	createLinkChips,
	setLinkChips,
} from '../link-chips'
import {
	type LossConstruct,
	type ReadOnlyCause,
	type SourceSession,
	buildSave,
	createSourceSession,
	findReadOnlyCause,
} from '../source-blocks'
import { type CommentRequest, EditorToolbar, type ToolbarAction } from './editor-toolbar'
import { MARKDOWN_PROSE_CLASS } from './prose'
import { MarkdownRenderer } from './renderer'

export type { EditorDisallowedNode, EditorVariant }
export type { CommentRequest, TextCommentHighlight }
export type { TextAnchor } from '../text-anchor'
export type { LinkChipHost, LinkChipTarget } from '../link-chips'

export interface MentionSuggestionItem {
	id: string
	label: string
}

/**
 * What the shared editor event carries. A real parse failure has reason
 * parse_error. A file or description that opens read-only has reason
 * read_only_fallback and a cause. A block the editor could not write back
 * without losing something has reason loss_check and the construct found.
 */
export interface MarkdownParseErrorInfo {
	errorMessage: string
	variant: EditorVariant
	surface: string | undefined
	objectId: string | undefined
	reason: 'parse_error' | 'read_only_fallback' | 'loss_check'
	cause?: ReadOnlyCause
	construct?: LossConstruct
}

/**
 * Keyboard shortcut identifier fired to `onShortcutUsed`. Matches the spec §8
 * shortcut column, lower-cased with `+` separators.
 */
export type EditorShortcut =
	| 'mod+b'
	| 'mod+i'
	| 'mod+shift+x'
	| 'mod+e'
	| 'mod+shift+k'
	| 'mod+alt+1'
	| 'mod+alt+2'
	| 'mod+alt+3'
	| 'mod+shift+7'
	| 'mod+shift+8'
	| 'mod+shift+9'
	| 'mod+shift+b'
	| 'mod+z'
	| 'mod+shift+z'
	| 'alt+f10'

export interface ToolbarActionInfo {
	action: ToolbarAction
	variant: EditorVariant
	surface: string | undefined
	objectId: string | undefined
}

export interface ShortcutInfo {
	shortcut: EditorShortcut
	variant: EditorVariant
	surface: string | undefined
}

export interface SavedInfo {
	variant: EditorVariant
	surface: string | undefined
	objectId: string | undefined
	/** Length of the markdown handed to onChange. */
	contentLength: number
	saveTrigger: 'blur'
}

export type { ToolbarAction }

export interface MarkdownEditorProps {
	value: string
	/** Fires on blur (matches today's `MarkdownContent` semantics — spec §9). */
	onChange: (markdown: string) => void
	/** Opt-in: fires per-transaction. Callers use it to render an "unsaved" chip. */
	onChangeInternal?: (markdown: string) => void
	/**
	 * Opt-in: fires after each transaction that changed the document, without
	 * serialising it. For callers that read the text later (autosave does so on
	 * its debounce, through the ref) and must not pay for it on every keystroke.
	 */
	onEdit?: () => void
	onBlur?: () => void
	onFocus?: () => void
	placeholder?: string
	autoFocus?: boolean
	readOnly?: boolean
	variant?: EditorVariant
	disallowedNodes?: EditorDisallowedNode[]
	mentionSuggestions?: (query: string) => Promise<MentionSuggestionItem[]>
	onSubmitShortcut?: () => void
	className?: string
	/** Accessible name for the editing field (sets aria-label on the editable element). */
	ariaLabel?: string
	extensions?: Extensions
	/**
	 * Fires when tiptap-markdown fails to parse `value` on mount, when
	 * `preserveSource` opens read-only, and when a rewrite is refused. Callers
	 * wire this to PostHog's `editor_markdown_parse_error` event — the fallback
	 * path itself renders the raw string as plain text so the editor never crashes.
	 */
	onParseError?: (info: MarkdownParseErrorInfo) => void
	/**
	 * Treat `value` as source text to protect. The editor writes back only the
	 * top-level blocks the person touched (every other block, the blank lines
	 * between blocks and the final newline come back as loaded), refuses to
	 * rewrite a block it cannot hold losslessly, and opens read-only when the
	 * text has front matter, raw HTML, footnotes or link reference definitions,
	 * or when its blocks cannot be matched. `onChange` and `onChangeInternal`
	 * then receive that text. Read-only and still-checking states render the
	 * normal read view.
	 */
	preserveSource?: boolean
	/** Free-text surface identifier passed to `onParseError` (spec §11). */
	surface?: string
	objectId?: string
	/**
	 * Fires when the user triggers a toolbar action (bold, italic, link, …).
	 * Callers wire this to PostHog's `editor_toolbar_action_used` event (spec §11).
	 */
	onToolbarAction?: (info: ToolbarActionInfo) => void
	/**
	 * Fires when the user triggers a keyboard shortcut listed in tech spec §8.
	 * Callers wire this to PostHog's `editor_shortcut_used` event.
	 */
	onShortcutUsed?: (info: ShortcutInfo) => void
	/**
	 * Fires once per blur that hands changed markdown to `onChange`, never per
	 * keystroke and never on a focus + blur with no edit. Callers wire this to
	 * PostHog's `editor_saved` event (spec §11).
	 */
	onSaved?: (info: SavedInfo) => void
	/**
	 * Comments on selected text to draw as highlights. The highlights are editor
	 * decorations only: nothing is written into the document or the markdown.
	 * Pass a stable (memoised) array; the editor redraws when it changes.
	 */
	textComments?: TextCommentHighlight[]
	/** The comment whose card is open; its highlight gets the active ring. */
	activeTextCommentId?: string | null
	/**
	 * Fires when the Comment action is chosen in the selection toolbar or the
	 * mobile format bar. Without it no Comment action is shown.
	 */
	onTextCommentRequest?: (request: CommentRequest) => void
	/** A highlight was clicked (its id), or the click landed elsewhere in the text (null). */
	onTextCommentClick?: (id: string | null) => void
	/** The comments whose quote no longer matches the text changed. */
	onTextCommentsOrphaned?: (orphanedIds: string[]) => void
	/** Element id of the panel card a highlight points at (aria-describedby). */
	textCommentDescribedBy?: (id: string) => string | undefined
	/**
	 * Draw the links the host recognises as chips, except the one the cursor touches. A drawing over
	 * the link only: nothing is written into the document or the markdown. Pass a stable
	 * (memoised) host; null or omitted draws plain links.
	 */
	linkChips?: LinkChipHost | null
}

export interface MarkdownEditorRef {
	focus(): void
	blur(): void
	insertContent(markdown: string): void
	getMarkdown(): string
	clear(): void
	/**
	 * Bring a comment's highlight into view. With focus, the caret also moves to
	 * the start of the highlight. Does nothing for an orphaned comment.
	 */
	scrollToTextComment(id: string, options?: { focus?: boolean }): void
}

const MAX_ERROR_MESSAGE_LENGTH = 500

function truncateErrorMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err)
	return raw.length > MAX_ERROR_MESSAGE_LENGTH ? `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : raw
}

/**
 * Emit-on-run keybinding extension. Overrides two shortcuts and adds one:
 * - `Mod-Shift-x` invokes Strike (default is `Mod-Shift-s`; spec §8 mandates
 *   `Mod+Shift+X` to match the toolbar tooltip).
 * - `Mod-Shift-k` invokes Link (Tiptap's Link ext ships no shortcut; the
 *   toolbar advertises `Mod+Shift+K`).
 * - `Mod-Shift-s` is dropped so Strike doesn't fire on both.
 * - `Alt-F10` moves keyboard focus into the toolbar while a selection is
 *   active (a no-op otherwise, so the key stays free for the browser).
 *
 * `Mod-k` is *deliberately unbound*. The global command palette
 * (`apps/web/src/components/command-palette.tsx:256`) listens on the document
 * without a `contentEditable` guard, so any binding here would clobber it
 * (tech spec §12 rabbit hole #5). Leaving it unbound means the palette wins.
 *
 * Every bound key that ends up executing (i.e. the command returned `true`)
 * calls `onShortcutFired` so the surrounding editor can forward it to
 * PostHog's `editor_shortcut_used` event (spec §11).
 */
function buildShortcutExtension(
	onShortcutFired: (shortcut: EditorShortcut) => void,
	toggleLinkPopover: () => void,
	focusToolbar: () => void,
) {
	const wrap = (shortcut: EditorShortcut, command: () => boolean) => () => {
		const ok = command()
		if (ok) onShortcutFired(shortcut)
		return ok
	}

	return Extension.create({
		name: 'maskinEditorShortcuts',
		// Higher than the default 100 so this extension's key handlers run
		// before the base extensions' (Bold/Italic/Strike/etc.) — we need to see the
		// shortcut firing to emit the PostHog event. If the default handler
		// consumed the key first, the emit never fires.
		priority: 1000,
		addKeyboardShortcuts() {
			return {
				// Overrides — the default was wrong per spec.
				'Mod-Shift-x': wrap('mod+shift+x', () => this.editor.chain().focus().toggleStrike().run()),
				// Drop the default Strike binding — spec says X, not S.
				'Mod-Shift-s': () => true,
				// New — Link has no default keybinding in @tiptap/extension-link.
				'Mod-Shift-k': () => {
					onShortcutFired('mod+shift+k')
					toggleLinkPopover()
					return true
				},

				// Backspace at the start of a heading or code block downgrades it to a
				// paragraph (spec §8). List items and quotes already lift out of
				// their wrapper through Tiptap's defaults; headings do not.
				Backspace: () => {
					const { selection } = this.editor.state
					if (!selection.empty || selection.$from.parentOffset !== 0) return false
					const blockType = selection.$from.parent.type.name
					if (blockType !== 'heading' && blockType !== 'codeBlock') return false
					return this.editor.commands.setParagraph()
				},
				'Alt-F10': () => {
					if (this.editor.state.selection.empty || !this.editor.isEditable) return false
					onShortcutFired('alt+f10')
					focusToolbar()
					return true
				},

				// Emit-on-run wrappers for shortcuts that already exist by default
				// in Tiptap. We delegate to the existing command rather than
				// re-implementing it; if the default extension is disabled (e.g.
				// heading on comment variant) the command returns false and no
				// event fires.
				'Mod-b': wrap('mod+b', () => this.editor.chain().focus().toggleBold().run()),
				'Mod-i': wrap('mod+i', () => this.editor.chain().focus().toggleItalic().run()),
				'Mod-e': wrap('mod+e', () => this.editor.chain().focus().toggleCode().run()),
				'Mod-Alt-1': wrap('mod+alt+1', () =>
					this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
				),
				'Mod-Alt-2': wrap('mod+alt+2', () =>
					this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
				),
				'Mod-Alt-3': wrap('mod+alt+3', () =>
					this.editor.chain().focus().toggleHeading({ level: 3 }).run(),
				),
				'Mod-Shift-7': wrap('mod+shift+7', () =>
					this.editor.chain().focus().toggleOrderedList().run(),
				),
				'Mod-Shift-8': wrap('mod+shift+8', () =>
					this.editor.chain().focus().toggleBulletList().run(),
				),
				'Mod-Shift-9': wrap('mod+shift+9', () =>
					this.editor.chain().focus().toggleTaskList().run(),
				),
				'Mod-Shift-b': wrap('mod+shift+b', () =>
					this.editor.chain().focus().toggleBlockquote().run(),
				),
				'Mod-z': wrap('mod+z', () => this.editor.chain().focus().undo().run()),
				'Mod-Shift-z': wrap('mod+shift+z', () => this.editor.chain().focus().redo().run()),
			}
		},
	})
}

/**
 * Rich Tiptap-based markdown editor. Dynamic-imported by callers so the
 * Tiptap chunk never bundles into a read-only route (spec §12 rabbit hole #6);
 * the Vite chunk-name CI assertion enforces this.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
	function MarkdownEditor(
		{
			value,
			onChange,
			onChangeInternal,
			onEdit,
			onBlur,
			onFocus,
			placeholder,
			autoFocus = false,
			readOnly = false,
			variant = 'document',
			disallowedNodes,
			onSubmitShortcut,
			className,
			ariaLabel,
			extensions,
			onParseError,
			preserveSource = false,
			surface,
			objectId,
			onToolbarAction,
			onShortcutUsed,
			onSaved,
			textComments,
			activeTextCommentId = null,
			onTextCommentRequest,
			onTextCommentClick,
			onTextCommentsOrphaned,
			textCommentDescribedBy,
			linkChips = null,
		},
		ref,
	) {
		// Track parse failure across renders so the fallback surface stays
		// mounted even after StrictMode double-renders and unmount cycles.
		const [parseFailed, setParseFailed] = useState(false)
		const parseErrorReportedRef = useRef(false)
		// Set by the first doc-changing transaction, cleared once onChange has
		// fired. Without it a focus + blur with no edit re-serialises the markdown
		// and saves it, where the Textarea path returns early when the draft
		// equals the saved content.
		const dirtyRef = useRef(false)
		// preserveSource: 'pending' until the text has been checked against the
		// read-only list, then 'editable' or 'readonly' for good (per mount).
		const [sourceStatus, setSourceStatus] = useState<'pending' | 'editable' | 'readonly'>(
			preserveSource ? 'pending' : 'editable',
		)
		const sourceSessionRef = useRef<SourceSession | null>(null)
		const readOnlyRef = useRef(false)
		const refusalsReportedRef = useRef(new Set<string>())

		// Toolbar state — set by the shortcut extension so `Mod+Shift+K`
		// opens the same link popover the toolbar button does.
		const [linkPopoverPulse, setLinkPopoverPulse] = useState(0)
		const [toolbarFocusPulse, setToolbarFocusPulse] = useState(0)

		// The keyboard-shortcut and toolbar-action forwarders are held in refs
		// so we can rebuild the extension list without also invalidating it on
		// every emit. Callers pass new closures on every render; the ref keeps
		// the extension identity stable across renders.
		const onShortcutUsedRef = useRef(onShortcutUsed)
		const onToolbarActionRef = useRef(onToolbarAction)
		useEffect(() => {
			onShortcutUsedRef.current = onShortcutUsed
		}, [onShortcutUsed])
		useEffect(() => {
			onToolbarActionRef.current = onToolbarAction
		}, [onToolbarAction])

		const emitShortcut = useCallback(
			(shortcut: EditorShortcut) => {
				onShortcutUsedRef.current?.({ shortcut, variant, surface })
			},
			[variant, surface],
		)

		const openLinkPopover = useCallback(() => {
			setLinkPopoverPulse((n) => n + 1)
		}, [])

		const focusToolbar = useCallback(() => {
			setToolbarFocusPulse((n) => n + 1)
		}, [])

		// The highlight layer reads its callbacks through a ref, so the extension
		// (and the editor built from it) stays the same across renders.
		const commentHandlersRef = useRef<CommentHighlightHandlers>({})
		commentHandlersRef.current = {
			onHighlightClick: onTextCommentClick,
			onOrphansChange: onTextCommentsOrphaned,
			describedBy: textCommentDescribedBy,
		}
		const commentExtension = useMemo(() => createCommentHighlights(commentHandlersRef), [])

		// Same for the link chips: the host is read through a ref, so the editor is not rebuilt when
		// it changes; the effect below pushes the new one in.
		const linkChipHandlersRef = useRef<LinkChipHandlers>({ host: null })
		linkChipHandlersRef.current = { host: linkChips }
		const linkChipExtension = useMemo(() => createLinkChips(linkChipHandlersRef), [])

		const shortcutExtension = useMemo(
			() => buildShortcutExtension(emitShortcut, openLinkPopover, focusToolbar),
			[emitShortcut, openLinkPopover, focusToolbar],
		)

		const tiptapExtensions = useMemo(
			() =>
				buildExtensions(
					variant,
					disallowedNodes,
					placeholder,
					[...(extensions ?? []), commentExtension, linkChipExtension],
					shortcutExtension,
				),
			[
				variant,
				disallowedNodes,
				placeholder,
				extensions,
				commentExtension,
				linkChipExtension,
				shortcutExtension,
			],
		)

		const reportParseError = useCallback(
			(errorMessage: string) => {
				if (parseErrorReportedRef.current) return
				parseErrorReportedRef.current = true
				setParseFailed(true)
				onParseError?.({ errorMessage, variant, surface, objectId, reason: 'parse_error' })
			},
			[onParseError, variant, surface, objectId],
		)

		// The markdown to hand to callers. With preserveSource it is the original
		// text with only the touched blocks rewritten; otherwise the editor's own
		// serialisation of the whole document.
		const markdownOf = useCallback(
			(e: Editor): string => {
				const session = sourceSessionRef.current
				if (!preserveSource || !session) return e.storage.markdown.getMarkdown() as string
				const result = buildSave(session, {
					current: serializeTopLevelBlocks(e),
					currentFeatures: (index) => nodeFeatures(e.state.doc.child(index)),
				})
				for (const refusal of result.refused) {
					const key = `${refusal.construct}:${refusal.blocks.join(',')}`
					if (refusalsReportedRef.current.has(key)) continue
					refusalsReportedRef.current.add(key)
					onParseError?.({
						errorMessage: `rewrite refused: ${refusal.construct}`,
						variant,
						surface,
						objectId,
						reason: 'loss_check',
						construct: refusal.construct,
					})
				}
				return result.text
			},
			[preserveSource, onParseError, variant, surface, objectId],
		)

		const editor = useEditor(
			{
				extensions: tiptapExtensions,
				content: value,
				editable: !readOnly,
				autofocus: autoFocus,
				onBlur: ({ editor: e }) => {
					if (dirtyRef.current) {
						try {
							const markdown = markdownOf(e)
							onChange(markdown)
							dirtyRef.current = false
							onSaved?.({
								variant,
								surface,
								objectId,
								contentLength: markdown.length,
								saveTrigger: 'blur',
							})
						} catch (err) {
							console.error('[maskin] markdown editor onBlur getMarkdown failed', err)
						}
					}
					onBlur?.()
				},
				onFocus: () => onFocus?.(),
				onUpdate: ({ editor: e }) => {
					dirtyRef.current = true
					onEdit?.()
					if (!onChangeInternal) return
					try {
						onChangeInternal(markdownOf(e))
					} catch {
						// swallow — the blur path is authoritative
					}
				},
				editorProps: {
					// Naming the field replaces Tiptap's own attributes, so keep its role here.
					attributes: ariaLabel ? { role: 'textbox', 'aria-label': ariaLabel } : {},
					handleKeyDown: (_view, event) => {
						if (
							variant === 'comment' &&
							onSubmitShortcut &&
							event.key === 'Enter' &&
							!event.shiftKey &&
							!event.isComposing &&
							typeof window !== 'undefined' &&
							!window.matchMedia?.('(pointer: coarse)').matches
						) {
							onSubmitShortcut()
							return true
						}
						return false
					},
				},
			},
			[tiptapExtensions],
		)

		// Hand the editor the comments to draw. A transaction with no document
		// change, so it never reaches onUpdate, autosave or the markdown.
		useEffect(() => {
			if (!editor || editor.isDestroyed) return
			setTextComments(editor.view, textComments ?? [], activeTextCommentId)
		}, [editor, textComments, activeTextCommentId])

		// Hand the editor the chip host. A transaction with no document change, so it never reaches
		// onUpdate, autosave or the markdown.
		useEffect(() => {
			if (!editor || editor.isDestroyed) return
			setLinkChips(editor.view, linkChips)
		}, [editor, linkChips])

		// preserveSource: check the text against the read-only list once the
		// editor has parsed it. Whole file, never half. A read-only open is one
		// event, and nothing is ever sent to the server from it.
		useEffect(() => {
			if (!editor || !preserveSource || sourceStatus !== 'pending') return
			try {
				const md = editorMarkdownIt(editor)
				const cause = findReadOnlyCause(md, value, editor.state.doc.childCount)
				if (cause) {
					// StrictMode runs this effect twice before the state lands.
					const alreadyReported = readOnlyRef.current
					readOnlyRef.current = true
					editor.setEditable(false)
					setSourceStatus('readonly')
					if (!alreadyReported) {
						onParseError?.({
							errorMessage: `opened read-only: ${cause}`,
							variant,
							surface,
							objectId,
							reason: 'read_only_fallback',
							cause,
						})
					}
					return
				}
				sourceSessionRef.current = createSourceSession(md, value, serializeTopLevelBlocks(editor))
				setSourceStatus('editable')
			} catch (err) {
				readOnlyRef.current = true
				editor.setEditable(false)
				setSourceStatus('readonly')
				onParseError?.({
					errorMessage: truncateErrorMessage(err),
					variant,
					surface,
					objectId,
					reason: 'parse_error',
				})
			}
		}, [editor, preserveSource, sourceStatus, value, onParseError, variant, surface, objectId])

		// Malformed-Markdown fallback: `tiptap-markdown` swallows most invalid
		// input silently rather than throwing, so an editor that mounts with
		// non-empty markdown but returns an empty doc is treated as a parse
		// failure — matches the AC's "no crash, plain text render, one event".
		useEffect(() => {
			if (!editor || parseFailed || readOnlyRef.current) return
			try {
				const roundTrip = editor.storage.markdown.getMarkdown() as string
				if (value.trim().length > 0 && roundTrip.trim().length === 0) {
					reportParseError('tiptap-markdown produced empty document from non-empty input')
				}
			} catch (err) {
				reportParseError(truncateErrorMessage(err))
			}
		}, [editor, value, parseFailed, reportParseError])

		const getMarkdown = useCallback((): string => {
			if (parseFailed) return value
			if (!editor) return value
			if (preserveSource && sourceStatus !== 'editable') return value
			try {
				return markdownOf(editor)
			} catch {
				return value
			}
		}, [editor, parseFailed, value, preserveSource, sourceStatus, markdownOf])

		useImperativeHandle(
			ref,
			() => ({
				focus: () => editor?.commands.focus(),
				blur: () => editor?.commands.blur(),
				insertContent: (markdown: string) => {
					editor?.commands.insertContent(markdown)
				},
				getMarkdown,
				clear: () => editor?.commands.clearContent(),
				scrollToTextComment: (id, options) => {
					if (!editor || editor.isDestroyed) return
					const range = textCommentRange(editor.state, id)
					if (!range) return
					if (options?.focus) {
						editor.chain().focus().setTextSelection(range.from).scrollIntoView().run()
						return
					}
					editor.view.dom
						.querySelector(`[data-comment-id="${id}"]`)
						?.scrollIntoView({ block: 'center', behavior: 'smooth' })
				},
			}),
			[editor, getMarkdown],
		)

		if (parseFailed) {
			return (
				<div className={className}>
					<pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">{value}</pre>
				</div>
			)
		}

		// Still checking, or opened read-only: the normal read view of the text.
		if (preserveSource && sourceStatus !== 'editable') {
			return (
				<div className={className}>
					<MarkdownRenderer content={value} />
				</div>
			)
		}

		const handleToolbarAction = (action: ToolbarAction) => {
			onToolbarActionRef.current?.({ action, variant, surface, objectId })
		}

		return (
			// One wrapper element: the toolbar's bubble menu moves its own node into the
			// editor DOM, so on a remount (key change) React must remove a single node.
			<div>
				<EditorContent
					editor={editor}
					className={className ? `${MARKDOWN_PROSE_CLASS} ${className}` : MARKDOWN_PROSE_CLASS}
				/>
				<EditorToolbar
					editor={editor}
					variant={variant}
					onToolbarAction={handleToolbarAction}
					openPulse={linkPopoverPulse}
					focusPulse={toolbarFocusPulse}
					onComment={readOnly ? undefined : onTextCommentRequest}
				/>
			</div>
		)
	},
)
