import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { MentionedText } from './mentioned-text'

function wrapWithMentions(children: ReactNode, actors: ActorListItem[]): ReactNode {
	if (typeof children === 'string') {
		return <MentionedText content={children} actors={actors} />
	}
	if (Array.isArray(children)) {
		return children.map((child, idx) =>
			typeof child === 'string' ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: children come from a deterministic markdown AST; order is stable across renders
				<MentionedText key={`m-${idx}`} content={child} actors={actors} />
			) : (
				child
			),
		)
	}
	return children
}

export function MarkdownContent({
	content,
	onChange,
	editable = false,
	className,
	size = 'sm',
	disallowedElements,
	mentionActors,
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
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

	const components = useMemo<Components | undefined>(() => {
		if (!mentionActors) return undefined
		const wrap = (children: ReactNode) => wrapWithMentions(children, mentionActors)
		return {
			p: ({ children }) => <p>{wrap(children)}</p>,
			li: ({ children }) => <li>{wrap(children)}</li>,
			em: ({ children }) => <em>{wrap(children)}</em>,
			strong: ({ children }) => <strong>{wrap(children)}</strong>,
			blockquote: ({ children }) => <blockquote>{wrap(children)}</blockquote>,
			del: ({ children }) => <del>{wrap(children)}</del>,
			a: ({ children, ...rest }) => <a {...rest}>{wrap(children)}</a>,
			td: ({ children, ...rest }) => <td {...rest}>{wrap(children)}</td>,
			th: ({ children, ...rest }) => <th {...rest}>{wrap(children)}</th>,
		}
	}, [mentionActors])

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
					'break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_img]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full',
					size === 'xs' && '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs',
				)}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm, remarkBreaks]}
					disallowedElements={disallowedElements}
					unwrapDisallowed={Boolean(disallowedElements && disallowedElements.length > 0)}
					components={components}
				>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	)
}
