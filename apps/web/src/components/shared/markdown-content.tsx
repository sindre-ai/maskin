import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { splitTextByUuids } from '@/lib/object-id-detection'
import {
	Fragment,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { InlineObjectChip } from './inline-object-chip'
import { MentionedText } from './mentioned-text'

interface TextWrapOptions {
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
	linkifyObjectIds?: boolean
	workspaceId?: string
}

function wrapString(content: string, opts: TextWrapOptions, keyPrefix: string): ReactNode {
	const { mentionActors, onMentionClick, linkifyObjectIds, workspaceId } = opts
	// Object-id linkification runs first so UUIDs are replaced with chip nodes;
	// mention highlighting then runs on the remaining text segments. Without
	// this order, the mention scanner would walk over UUID substrings and the
	// chip renderer would have to dig into mention spans.
	if (linkifyObjectIds && workspaceId) {
		const parts = splitTextByUuids(content)
		if (parts.some((p) => p.type === 'uuid')) {
			return (
				<>
					{parts.map((part, idx) => {
						const key = `${keyPrefix}-${idx}`
						if (part.type === 'uuid') {
							return <InlineObjectChip key={key} objectId={part.value} workspaceId={workspaceId} />
						}
						if (mentionActors) {
							return (
								<MentionedText
									key={key}
									content={part.value}
									actors={mentionActors}
									onMentionClick={onMentionClick}
								/>
							)
						}
						return <Fragment key={key}>{part.value}</Fragment>
					})}
				</>
			)
		}
	}
	if (mentionActors) {
		return (
			<MentionedText content={content} actors={mentionActors} onMentionClick={onMentionClick} />
		)
	}
	return content
}

function wrapText(children: ReactNode, opts: TextWrapOptions): ReactNode {
	if (typeof children === 'string') {
		return wrapString(children, opts, 'w')
	}
	if (Array.isArray(children)) {
		return children.map((child, idx) =>
			typeof child === 'string' ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: children come from a deterministic markdown AST; order is stable across renders
				<Fragment key={`w-${idx}`}>{wrapString(child, opts, `w-${idx}`)}</Fragment>
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
	onMentionClick,
	linkifyObjectIds = false,
	workspaceId,
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
	/**
	 * When true, bare object UUIDs in the text are replaced with inline
	 * ObjectReference chips that deep-link to the object. Requires `workspaceId`.
	 */
	linkifyObjectIds?: boolean
	workspaceId?: string
}) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(content)
	const containerRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	// Height of the rendered prose view at the moment edit mode is entered.
	// Used as a floor so the box doesn't shrink when headings/lists collapse to plain text.
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

	const components = useMemo<Components>(() => {
		// Inline code spans that contain a bare URL render as a clickable link instead
		// of styled monospace — agents commonly write URLs in backticks and the
		// remark-breaks + remark-gfm combination doesn't always autolink them.
		const code: Components['code'] = ({ children, className }) => {
			if (!className) {
				const text = typeof children === 'string' ? children.trim() : ''
				if (!text.includes('\n') && /^https?:\/\/\S+$/.test(text)) {
					return (
						<a href={text} target="_blank" rel="noopener noreferrer">
							{text}
						</a>
					)
				}
			}
			return <code className={className}>{children}</code>
		}

		const needsWrap = Boolean(mentionActors) || (linkifyObjectIds && Boolean(workspaceId))
		if (!needsWrap) return { code }
		const wrapOpts: TextWrapOptions = {
			mentionActors,
			onMentionClick,
			linkifyObjectIds,
			workspaceId,
		}
		const wrap = (children: ReactNode) => wrapText(children, wrapOpts)
		return {
			code,
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
	}, [mentionActors, onMentionClick, linkifyObjectIds, workspaceId])

	if (editable && editing) {
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
