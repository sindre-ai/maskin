import { CommentVisual, isVisualLanguage } from '@/components/activity/comment-visual'
import { Textarea } from '@/components/ui/textarea'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import type { ActorListItem } from '@/lib/api'
import { capture } from '@/lib/posthog'
import {
	MarkdownRenderer,
	type MentionActor,
	type RenderCodeBlockArgs,
} from '@maskin/markdown/react'
import type { MarkdownParseErrorInfo } from '@maskin/markdown/react/editor'
import { Suspense, lazy, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

// Dynamic-imported so Tiptap never bundles into a read-only route — read paths
// (feeds, notifications, marketing) never touch this chunk. The Vite chunk-
// name CI assertion (`apps/web/scripts/assert-editor-chunk.mjs`) enforces the
// split at build time. See tech spec §12 rabbit hole #6.
const MarkdownEditor = lazy(() =>
	import('@maskin/markdown/react/editor').then((m) => ({ default: m.MarkdownEditor })),
)

interface MarkdownContentProps {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
	/**
	 * Opt-in: when true, fenced blocks tagged ```chart render as inline visuals
	 * (e.g. recharts). Defaults to false so object-document body markdown is
	 * unaffected — only ActivityComment opts in.
	 */
	renderVisuals?: boolean
}

/**
 * Thin adapter over the split `@maskin/markdown/react` package (bet `666e3c4a`).
 *
 * - `editable=false` → `<MarkdownRenderer>` (react-markdown, unchanged bundle
 *   posture — 0 KB added on read routes).
 * - `editable=true` + `rich-markdown-editor` flag on → `<MarkdownEditor>` from
 *   the Tiptap chunk (dynamic-imported). Flag off falls back to today's
 *   `<Textarea>` blur-emit behaviour so nothing changes for a flag-off user.
 *
 * Blur-emit save semantics are preserved on both branches — `onChange(markdown)`
 * fires only on blur (tech spec §9).
 */
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
}: MarkdownContentProps) {
	const editorEnabled = useFeatureFlag('rich-markdown-editor')

	if (editable && editorEnabled) {
		return (
			<EditorAdapter
				content={content}
				onChange={onChange}
				className={className}
				disallowedElements={disallowedElements}
			/>
		)
	}

	if (editable) {
		return <TextareaAdapter content={content} onChange={onChange} className={className} />
	}

	const renderCodeBlock = renderVisuals
		? ({ language, source }: RenderCodeBlockArgs) => {
				if (isVisualLanguage(language)) {
					return <CommentVisual language={language ?? ''} source={source} />
				}
				return undefined
			}
		: undefined

	return (
		<MarkdownRenderer
			content={content}
			className={className}
			size={size}
			disallowedElements={disallowedElements}
			mentionActors={mentionActors as MentionActor[] | undefined}
			onMentionClick={onMentionClick as ((actor: MentionActor) => void) | undefined}
			renderVisuals={renderVisuals}
			renderCodeBlock={renderCodeBlock}
		/>
	)
}

// Flag-off: today's edit-in-place behaviour verbatim. Click the rendered
// markdown to swap in a plain `<Textarea>`, blur-emit the draft on exit,
// preserve the original box height so headings don't collapse the layout.
function TextareaAdapter({
	content,
	onChange,
	className,
}: {
	content: string
	onChange?: (value: string) => void
	className?: string
}) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(content)
	const containerRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const [lockedHeight, setLockedHeight] = useState<number | undefined>(undefined)

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

	if (editing) {
		return (
			<Textarea
				ref={textareaRef}
				className="w-full bg-transparent text-sm text-muted-foreground font-sans resize-none outline-none border-none p-0 focus:outline-none overflow-hidden"
				style={{ minHeight: lockedHeight, lineHeight: '1.7142857' }}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value)
					adjustHeight()
				}}
				onBlur={handleBlur}
				autoFocus
			/>
		)
	}

	if (!content) {
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
			ref={containerRef}
			className={className}
			onClick={() => startEditing(content)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') startEditing(content)
			}}
			// biome-ignore lint/a11y/useSemanticElements: rendered markdown holds block-level content (headings, lists) that cannot legally nest inside <button>; div + role=button is the standing pattern
			role="button"
			tabIndex={0}
		>
			<MarkdownRenderer content={content} />
		</div>
	)
}

// Flag-on: dynamic-imported Tiptap surface. Blur-emit is delegated to the
// editor itself (spec §9). While the chunk is fetching, render the raw
// markdown so nothing flashes empty. `surface` / `objectId` are left
// undefined here — Task 6 threads them through consumer call sites.
function EditorAdapter({
	content,
	onChange,
	className,
	disallowedElements,
}: {
	content: string
	onChange?: (value: string) => void
	className?: string
	disallowedElements?: string[]
}) {
	const handleChange = useCallback(
		(markdown: string) => {
			onChange?.(markdown)
		},
		[onChange],
	)

	const handleParseError = useCallback((info: MarkdownParseErrorInfo) => {
		capture('editor_markdown_parse_error', {
			error_message: info.errorMessage,
			variant: info.variant,
			surface: info.surface,
			object_id: info.objectId,
		})
	}, [])

	const disallowedNodes = useMemo(() => {
		if (!disallowedElements) return undefined
		const nodes: Array<'heading' | 'table' | 'taskList' | 'codeBlock'> = []
		if (disallowedElements.some((el) => /^h[1-6]$/.test(el))) nodes.push('heading')
		if (disallowedElements.includes('table')) nodes.push('table')
		return nodes.length > 0 ? nodes : undefined
	}, [disallowedElements])

	return (
		<Suspense
			fallback={
				<div className={className}>
					<MarkdownRenderer content={content} />
				</div>
			}
		>
			<MarkdownEditor
				value={content}
				onChange={handleChange}
				variant="document"
				className={className}
				disallowedNodes={disallowedNodes}
				onParseError={handleParseError}
			/>
		</Suspense>
	)
}
