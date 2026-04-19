import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WIKILINK_RE = /\[\[([^\]]+)]]/g

/**
 * Transforms [[<uuid>]], [[<uuid>|label]], and [[Article title]] patterns in
 * markdown text into link nodes. UUID targets navigate to the object's detail
 * page; free-text targets open the knowledge-scoped search so the reader can
 * find the intended article.
 *
 * Requires a workspaceId so the emitted paths are absolute within the workspace.
 */
function createRemarkWikiLinks(workspaceId: string) {
	return () => (tree: unknown) => {
		visit(tree as Parameters<typeof visit>[0], 'text', (node, index, parent) => {
			if (!parent || typeof index !== 'number') return
			const value = (node as { value: string }).value
			if (!value.includes('[[')) return

			const children: unknown[] = []
			let lastIdx = 0
			let match: RegExpExecArray | null
			WIKILINK_RE.lastIndex = 0
			// biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec pattern
			while ((match = WIKILINK_RE.exec(value)) !== null) {
				if (match.index > lastIdx) {
					children.push({ type: 'text', value: value.slice(lastIdx, match.index) })
				}
				const raw = match[1]
				const pipeIdx = raw.indexOf('|')
				const target = pipeIdx >= 0 ? raw.slice(0, pipeIdx).trim() : raw.trim()
				const label = pipeIdx >= 0 ? raw.slice(pipeIdx + 1).trim() : target
				const url = UUID_RE.test(target)
					? `/${workspaceId}/wiki/${target}`
					: `/${workspaceId}/objects?type=knowledge&search=${encodeURIComponent(target)}`
				children.push({
					type: 'link',
					url,
					title: null,
					children: [{ type: 'text', value: label }],
				})
				lastIdx = match.index + match[0].length
			}
			if (lastIdx === 0) return
			if (lastIdx < value.length) {
				children.push({ type: 'text', value: value.slice(lastIdx) })
			}
			;(parent as { children: unknown[] }).children.splice(index, 1, ...children)
			return index + children.length
		})
	}
}

export function MarkdownContent({
	content,
	onChange,
	editable = false,
	className,
	size = 'sm',
	workspaceId,
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
	/**
	 * When provided, enables `[[Article]]` / `[[<uuid>]]` wikilink rendering.
	 * Omit (or leave undefined) for contexts where wikilinks should pass through
	 * as literal text.
	 */
	workspaceId?: string
}) {
	const remarkPlugins = useMemo(
		() =>
			workspaceId
				? [remarkGfm, createRemarkWikiLinks(workspaceId), remarkBreaks]
				: [remarkGfm, remarkBreaks],
		[workspaceId],
	)
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(content)
	const containerRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const [containerHeight, setContainerHeight] = useState<number | undefined>(undefined)

	const handleBlur = useCallback(() => {
		setEditing(false)
		if (draft !== content) {
			onChange?.(draft)
		}
	}, [draft, content, onChange])

	const startEditing = (initialDraft: string) => {
		if (containerRef.current) {
			setContainerHeight(containerRef.current.offsetHeight)
		}
		setDraft(initialDraft)
		setEditing(true)
	}

	const autoResize = useCallback(() => {
		const ta = textareaRef.current
		if (ta) {
			ta.style.height = 'auto'
			const scrollHeight = ta.scrollHeight
			const minHeight = containerHeight ?? 0
			ta.style.height = `${Math.max(scrollHeight, minHeight)}px`
		}
	}, [containerHeight])

	useEffect(() => {
		if (editing) autoResize()
	}, [editing, autoResize])

	if (editable && editing) {
		return (
			<Textarea
				ref={textareaRef}
				className="w-full bg-transparent text-sm text-muted-foreground font-sans resize-none outline-none border-none p-0 focus:outline-none overflow-hidden"
				style={{ minHeight: containerHeight, lineHeight: '1.7142857' }}
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value)
					autoResize()
				}}
				onBlur={handleBlur}
				autoFocus
			/>
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
			ref={containerRef}
			className={className}
			onClick={() => {
				if (editable) startEditing(content)
			}}
			onKeyDown={(e) => {
				if (editable && (e.key === 'Enter' || e.key === ' ')) startEditing(content)
			}}
			tabIndex={editable ? 0 : undefined}
		>
			<div
				className={cn(
					'prose dark:prose-invert prose-sm max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-p:leading-[1.7142857] prose-li:text-muted-foreground prose-a:text-primary prose-strong:text-foreground prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded',
					size === 'xs' && '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs',
				)}
			>
				<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={[rehypeSlug]}>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	)
}
