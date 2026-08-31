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
import type { SaveTrigger, EditorVariant as TelemetryEditorVariant } from './telemetry'

// One lowlight instance across every editor mount — building the language
// registry is not free and it never changes at runtime.
const lowlight = createLowlight(common)

// Single source of truth for the variant literal lives in `./telemetry`; the
// re-export here keeps `EditorVariant` importable from `@maskin/markdown/react/editor`
// without pulling telemetry into every consumer's type imports.
export type EditorVariant = TelemetryEditorVariant

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
 * Payload for `onSaved` (spec §11 `editor_saved`). Fires on blur for the
 * document variant, and on the submit shortcut for the comment variant when
 * that variant ships.
 */
export interface EditorSavedInfo {
	markdown: string
	contentLength: number
	saveTrigger: SaveTrigger
	variant: EditorVariant
	surface: string | undefined
	objectId: string | undefined
}

/**
 * Payload for `onSlashCommand` (spec §11 `editor_slash_command_used`). Task 2
 * fires this from the slash-menu extension after the user picks a command;
 * `command_id` is the picked item's stable id (e.g. `heading_1`).
 */
export interface SlashCommandInfo {
	commandId: string
	variant: EditorVariant
	surface: string | undefined
	objectId: string | undefined
}

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
	/**
	 * Fires when the user finalizes an edit. On the `document` variant that is
	 * the editor's blur. On the `comment` variant it will fire on the submit
	 * shortcut (comment variant ships in a follow-up bet — the callback is
	 * wired now so Task 5 delivers the full `editor_saved` end-state).
	 */
	onSaved?: (info: EditorSavedInfo) => void
	/**
	 * Slot for Task 2's slash-menu extension: called with the picked command's
	 * id every time the user selects an item (spec §11 `editor_slash_command_used`).
	 * The extension gets a hold of this callback via a Tiptap storage bag
	 * exposed on the editor at `editor.storage.maskinSlashCommand.emit(id)` —
	 * Task 2's slash extension will invoke that emitter after inserting the
	 * block. Storing it on `editor.storage` keeps the emitter reachable from
	 * inside Tiptap extensions (which don't get React context).
	 */
	onSlashCommand?: (info: SlashCommandInfo) => void
	/** Free-text surface identifier passed to `onParseError` (spec §11). */
	surface?: string
	objectId?: string
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

function buildExtensions(
	variant: EditorVariant,
	disallowedNodes: EditorDisallowedNode[] | undefined,
	placeholder: string | undefined,
	extra: Extensions | undefined,
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
			onSaved,
			onSlashCommand,
			surface,
			objectId,
		},
		ref,
	) {
		// Hold the current `onSaved` / `onSlashCommand` in refs so the Tiptap
		// callback closures don't need to be rebuilt every render. Rebuilding
		// them would re-init the editor (via the `[tiptapExtensions]` dep),
		// which drops undo history and reloads the doc — a regression against
		// tech spec §9's autosave semantics.
		const onSavedRef = useRef(onSaved)
		const onSlashCommandRef = useRef(onSlashCommand)
		useEffect(() => {
			onSavedRef.current = onSaved
		}, [onSaved])
		useEffect(() => {
			onSlashCommandRef.current = onSlashCommand
		}, [onSlashCommand])
		// Track parse failure across renders so the fallback surface stays
		// mounted even after StrictMode double-renders and unmount cycles.
		const [parseFailed, setParseFailed] = useState(false)
		const parseErrorReportedRef = useRef(false)

		const tiptapExtensions = useMemo(
			() => buildExtensions(variant, disallowedNodes, placeholder, extensions),
			[variant, disallowedNodes, placeholder, extensions],
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
						// `editor_saved` fires on blur (spec §11). Not gated on
						// content change — a blur is the save trigger, whether or
						// not the content mutated. `contentLength` reads the
						// finalized markdown so the metric matches what got sent
						// to `onChange`.
						onSavedRef.current?.({
							markdown,
							contentLength: markdown.length,
							saveTrigger: 'blur',
							variant,
							surface,
							objectId,
						})
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
							try {
								const markdown = _view.state.doc.textContent
								// `editor_saved` also fires on the comment
								// variant's submit shortcut — the comment
								// variant itself ships in a follow-up bet but
								// the wiring lands here so Task 5 delivers the
								// full `editor_saved` end-state.
								onSavedRef.current?.({
									markdown,
									contentLength: markdown.length,
									saveTrigger: 'submit',
									variant,
									surface,
									objectId,
								})
							} catch {
								// Analytics must never break the submit path.
							}
							onSubmitShortcut()
							return true
						}
						return false
					},
				},
			},
			[tiptapExtensions],
		)

		// Expose a bag on `editor.storage` that Task 2's slash-menu extension
		// can reach from inside Tiptap (no React context available there).
		// Reads the latest `onSlashCommand` via ref so the extension always
		// sees the current callback.
		useEffect(() => {
			if (!editor) return
			const storage = editor.storage as Record<string, unknown>
			storage.maskinSlashCommand = {
				emit: (commandId: string) => {
					onSlashCommandRef.current?.({ commandId, variant, surface, objectId })
				},
			}
			return () => {
				// Clear the bag rather than `delete`ing the key (biome's noDelete
				// rule): the emitter is unusable once the closure's editor is
				// destroyed, and Task 2's extension can no-op on `undefined`.
				storage.maskinSlashCommand = undefined
			}
		}, [editor, variant, surface, objectId])

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

		return <EditorContent editor={editor} className={className} />
	},
)
