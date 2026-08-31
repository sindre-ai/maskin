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
			surface,
			objectId,
		},
		ref,
	) {
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

		return <EditorContent editor={editor} className={className} />
	},
)
