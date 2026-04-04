import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

export function MarkdownContent({
	content,
	onChange,
	editable = false,
	className,
	size = 'sm',
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
}) {
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
				className="w-full bg-transparent text-sm text-foreground font-sans resize-none outline-none border-none p-0 focus:outline-none overflow-hidden"
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
					'prose dark:prose-invert prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground prose-p:leading-[1.7142857] prose-li:text-foreground prose-a:text-primary prose-strong:text-foreground prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded prose-blockquote:text-muted-foreground',
					size === 'xs' && '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs',
				)}
			>
				<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
			</div>
		</div>
	)
}
