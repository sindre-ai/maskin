import { cn } from '@/lib/cn'
import { editorHtmlToMarkdown, markdownToEditorHtml } from '@maskin/markdown/tiptap'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorBubbleMenu } from './editor-bubble-menu'

const lowlight = createLowlight(common)

interface TipTapEditorProps {
	/**
	 * Current markdown content (source of truth). When this changes to a value
	 * that does not match the editor's current document (route-param flip,
	 * external SSE update), the editor's doc is reset via `setContent` — no
	 * `key={id}` remount, so focus/undo/debounce survive.
	 */
	value: string
	/**
	 * Called with canonical Markdown after each edit, debounced by `debounceMs`.
	 * The caller autosaves via the same channel the textarea used — the editor
	 * does not know about the PATCH endpoint.
	 */
	onChange: (markdown: string) => void
	/** Fired on blur so the parent can exit its edit-mode state. */
	onBlur?: () => void
	placeholder?: string
	className?: string
	/** Debounce window before onChange fires. 300ms sits inside the 200–500ms DoD window. */
	debounceMs?: number
	autoFocus?: boolean
}

// Canonicalise any HTML that lands in a paste event by round-tripping it
// through the owned serializer. This is the "no raw HTML in or out" gate:
// pasting a Notion export or a GitHub-rendered table is normalised to
// Markdown before it enters the document, and getHTML() → autosave passes
// through the same serializer on the way out.
function normalizePastedHtml(html: string): string {
	const markdown = editorHtmlToMarkdown(html)
	return markdownToEditorHtml(markdown)
}

export function TipTapEditor({
	value,
	onChange,
	onBlur,
	placeholder = "Write here — supports Markdown shortcuts. Type '/' for a block, or select text for formatting.",
	className,
	debounceMs = 300,
	autoFocus = false,
}: TipTapEditorProps) {
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// Tracks the last markdown we emitted to the parent, so a prop-value
	// change caused by our own autosave (echoed back through the query cache)
	// does not trigger a needless setContent + cursor jump.
	const lastEmittedRef = useRef<string>(value)

	// The editor owns its document after first render — later `value` changes
	// are pushed via the prop-change effect below (setContent), not by
	// recomputing `initialHtml`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only seed
	const initialHtml = useMemo(() => markdownToEditorHtml(value), [])

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				codeBlock: false,
				link: false,
			}),
			Link.configure({ openOnClick: false }),
			Placeholder.configure({ placeholder }),
			CodeBlockLowlight.configure({ lowlight }),
			Table.configure({ resizable: false }),
			TableRow,
			TableHeader,
			TableCell,
			TaskList,
			TaskItem.configure({ nested: true }),
		],
		content: initialHtml,
		autofocus: autoFocus,
		editorProps: {
			attributes: {
				class: cn(
					'prose dark:prose-invert prose-sm max-w-none focus:outline-none',
					'prose-headings:text-foreground prose-p:text-muted-foreground',
					'prose-p:leading-[1.7142857] prose-li:text-muted-foreground',
					'prose-a:text-primary prose-strong:text-foreground',
					'prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded',
					'break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full',
					'[&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full',
				),
			},
			transformPastedHTML: (html) => normalizePastedHtml(html),
			transformPastedText: (text) => text,
		},
		onUpdate: ({ editor }) => {
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				const markdown = editorHtmlToMarkdown(editor.getHTML())
				lastEmittedRef.current = markdown
				onChangeRef.current(markdown)
			}, debounceMs)
		},
		onBlur: ({ editor }) => {
			// Flush any pending debounced write on blur so exiting edit mode
			// commits the last keystroke immediately.
			if (debounceRef.current) {
				clearTimeout(debounceRef.current)
				debounceRef.current = null
				const markdown = editorHtmlToMarkdown(editor.getHTML())
				lastEmittedRef.current = markdown
				onChangeRef.current(markdown)
			}
			onBlur?.()
		},
	})

	// Prop-change reset (route-param knowledge article). When `value` moves
	// to something we didn't just emit ourselves — a nav to a different
	// object, an SSE-driven cache invalidation from an agent write — push it
	// into the editor via setContent. Same instance, no `key={id}` remount,
	// so focus/undo/debounce survive. Comparing against `lastEmittedRef`
	// avoids the autosave echo (parent re-passes the value we sent) turning
	// into a needless setContent + cursor jump.
	const [prevValue, setPrevValue] = useState(value)
	if (value !== prevValue) {
		setPrevValue(value)
		if (editor && !editor.isDestroyed && value !== lastEmittedRef.current) {
			lastEmittedRef.current = value
			editor.commands.setContent(markdownToEditorHtml(value), { emitUpdate: false })
		}
	}

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current)
		}
	}, [])

	return (
		<>
			<EditorContent editor={editor} className={className} />
			{editor && <EditorBubbleMenu editor={editor} />}
		</>
	)
}
