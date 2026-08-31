import { Extension } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import type { Extensions } from '@tiptap/react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'
import { Markdown } from 'tiptap-markdown'
import { EditorToolbar, type ToolbarAction } from './editor-toolbar'

// One lowlight instance across every editor mount — building the language
// registry is not free and it never changes at runtime.
const lowlight = createLowlight(common)

export type EditorVariant = 'document' | 'comment' | 'notification'

export type EditorDisallowedNode = 'heading' | 'table' | 'taskList' | 'codeBlock'

export interface MentionSuggestionItem {
	id: string
	label: string
}

export interface MarkdownParseErrorInfo {
	errorMessage: string
	variant: EditorVariant
	surface: string | undefined
	objectId: string | undefined
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

export type { ToolbarAction }

export interface MarkdownEditorProps {
	value: string
	/** Fires on blur (matches today's `MarkdownContent` semantics — spec §9). */
	onChange: (markdown: string) => void
	/** Opt-in: fires per-transaction. Callers use it to render an "unsaved" chip. */
	onChangeInternal?: (markdown: string) => void
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
	extensions?: Extensions
	/**
	 * Fires when tiptap-markdown fails to parse `value` on mount. Callers wire
	 * this to PostHog's `editor_markdown_parse_error` event — the fallback path
	 * itself renders the raw string as plain text so the editor never crashes.
	 */
	onParseError?: (info: MarkdownParseErrorInfo) => void
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
}

export interface MarkdownEditorRef {
	focus(): void
	blur(): void
	insertContent(markdown: string): void
	getMarkdown(): string
	clear(): void
}

const MAX_ERROR_MESSAGE_LENGTH = 500

function truncateErrorMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err)
	return raw.length > MAX_ERROR_MESSAGE_LENGTH ? `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : raw
}

const HEADING_LEVELS_BY_VARIANT: Record<EditorVariant, Array<1 | 2 | 3>> = {
	document: [1, 2, 3],
	comment: [],
	notification: [],
}

/**
 * Emit-on-run keybinding extension. Overrides two shortcuts and adds one:
 * - `Mod-Shift-x` invokes Strike (default is `Mod-Shift-s`; spec §8 mandates
 *   `Mod+Shift+X` to match the toolbar tooltip).
 * - `Mod-Shift-k` invokes Link (Tiptap's Link ext ships no shortcut; the
 *   toolbar advertises `Mod+Shift+K`).
 * - `Mod-Shift-s` is dropped so Strike doesn't fire on both.
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
) {
	const wrap = (shortcut: EditorShortcut, command: () => boolean) => () => {
		const ok = command()
		if (ok) onShortcutFired(shortcut)
		return ok
	}

	return Extension.create({
		name: 'maskinEditorShortcuts',
		// Higher than the default 100 so this extension's key handlers run
		// before StarterKit's (Bold/Italic/Strike/etc.) — we need to see the
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

function buildExtensions(
	variant: EditorVariant,
	disallowedNodes: EditorDisallowedNode[] | undefined,
	placeholder: string | undefined,
	extra: Extensions | undefined,
	shortcutExtension: ReturnType<typeof buildShortcutExtension>,
): Extensions {
	const disallowed = new Set<EditorDisallowedNode>(disallowedNodes ?? [])
	const headingLevels = HEADING_LEVELS_BY_VARIANT[variant]
	const includeHeading = headingLevels.length > 0 && !disallowed.has('heading')
	const includeTable = variant === 'document' && !disallowed.has('table')
	const includeTaskList = variant !== 'notification' && !disallowed.has('taskList')
	const includeCodeBlock = !disallowed.has('codeBlock')

	const extensions: Extensions = [
		// StarterKit ships Doc, Paragraph, Text, Bold, Italic, Strike, BulletList,
		// OrderedList, ListItem, Blockquote, HorizontalRule, Code (inline),
		// HardBreak, History, Dropcursor, Gapcursor. CodeBlock is replaced by
		// CodeBlockLowlight below; Heading is variant-gated.
		StarterKit.configure({
			codeBlock: false,
			heading: includeHeading ? { levels: headingLevels } : false,
		}),
		Link.configure({
			openOnClick: false,
			autolink: true,
			HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
		}),
		Placeholder.configure({
			placeholder: placeholder ?? 'Write, or press / for commands',
		}),
		// Round-trips markdown to a ProseMirror doc on load and back to markdown
		// on save. Fenced code, GFM tables, task lists, strike all flow through.
		Markdown.configure({
			html: false,
			tightLists: true,
			bulletListMarker: '-',
			linkify: false,
			breaks: true,
			transformPastedText: true,
			transformCopiedText: true,
		}),
	]

	if (includeCodeBlock) {
		extensions.push(CodeBlockLowlight.configure({ lowlight }))
	}

	if (includeTable) {
		extensions.push(Table.configure({ resizable: false }), TableRow, TableHeader, TableCell)
	}

	if (includeTaskList) {
		extensions.push(TaskList, TaskItem.configure({ nested: true }))
	}

	// Shortcut extension is variant-agnostic; the individual key handlers
	// return the command result, so a shortcut whose command is disabled
	// (e.g. heading on comment variant) is a no-op and doesn't emit.
	extensions.push(shortcutExtension)

	if (extra) extensions.push(...extra)

	return extensions
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
			onBlur,
			onFocus,
			placeholder,
			autoFocus = false,
			readOnly = false,
			variant = 'document',
			disallowedNodes,
			onSubmitShortcut,
			className,
			extensions,
			onParseError,
			surface,
			objectId,
			onToolbarAction,
			onShortcutUsed,
		},
		ref,
	) {
		// Track parse failure across renders so the fallback surface stays
		// mounted even after StrictMode double-renders and unmount cycles.
		const [parseFailed, setParseFailed] = useState(false)
		const parseErrorReportedRef = useRef(false)

		// Toolbar state — set by the shortcut extension so `Mod+Shift+K`
		// opens the same link popover the toolbar button does.
		const [linkPopoverPulse, setLinkPopoverPulse] = useState(0)

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

		const shortcutExtension = useMemo(
			() => buildShortcutExtension(emitShortcut, openLinkPopover),
			[emitShortcut, openLinkPopover],
		)

		const tiptapExtensions = useMemo(
			() => buildExtensions(variant, disallowedNodes, placeholder, extensions, shortcutExtension),
			[variant, disallowedNodes, placeholder, extensions, shortcutExtension],
		)

		const reportParseError = useCallback(
			(errorMessage: string) => {
				if (parseErrorReportedRef.current) return
				parseErrorReportedRef.current = true
				setParseFailed(true)
				onParseError?.({ errorMessage, variant, surface, objectId })
			},
			[onParseError, variant, surface, objectId],
		)

		const editor = useEditor(
			{
				extensions: tiptapExtensions,
				content: value,
				editable: !readOnly,
				autofocus: autoFocus,
				onBlur: ({ editor: e }) => {
					try {
						const markdown = e.storage.markdown.getMarkdown() as string
						onChange(markdown)
					} catch (err) {
						console.error('[maskin] markdown editor onBlur getMarkdown failed', err)
					}
					onBlur?.()
				},
				onFocus: () => onFocus?.(),
				onUpdate: ({ editor: e }) => {
					if (!onChangeInternal) return
					try {
						onChangeInternal(e.storage.markdown.getMarkdown() as string)
					} catch {
						// swallow — the blur path is authoritative
					}
				},
				editorProps: {
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

		// Malformed-Markdown fallback: `tiptap-markdown` swallows most invalid
		// input silently rather than throwing, so an editor that mounts with
		// non-empty markdown but returns an empty doc is treated as a parse
		// failure — matches the AC's "no crash, plain text render, one event".
		useEffect(() => {
			if (!editor || parseFailed) return
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
			try {
				return editor.storage.markdown.getMarkdown() as string
			} catch {
				return value
			}
		}, [editor, parseFailed, value])

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

		const handleToolbarAction = (action: ToolbarAction) => {
			onToolbarActionRef.current?.({ action, variant, surface, objectId })
		}

		return (
			<>
				<EditorContent editor={editor} className={className} />
				<EditorToolbar
					editor={editor}
					variant={variant}
					onToolbarAction={handleToolbarAction}
					openPulse={linkPopoverPulse}
				/>
			</>
		)
	},
)
