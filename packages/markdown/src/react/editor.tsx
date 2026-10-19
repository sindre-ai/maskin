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
import { editorMarkdownIt, nodeFeatures, serializeTopLevelBlocks } from '../editor-blocks'
import { type EditorDisallowedNode, type EditorVariant, buildExtensions } from '../extensions'
import {
	type LossConstruct,
	type ReadOnlyCause,
	type SourceSession,
	buildSave,
	createSourceSession,
	findReadOnlyCause,
} from '../source-blocks'
import { MarkdownRenderer } from './renderer'

export type { EditorDisallowedNode, EditorVariant }

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
			preserveSource = false,
			surface,
			objectId,
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

		const tiptapExtensions = useMemo(
			() => buildExtensions(variant, disallowedNodes, placeholder, extensions),
			[variant, disallowedNodes, placeholder, extensions],
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
						} catch (err) {
							console.error('[maskin] markdown editor onBlur getMarkdown failed', err)
						}
					}
					onBlur?.()
				},
				onFocus: () => onFocus?.(),
				onUpdate: ({ editor: e }) => {
					dirtyRef.current = true
					if (!onChangeInternal) return
					try {
						onChangeInternal(markdownOf(e))
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

		return <EditorContent editor={editor} className={className} />
	},
)
