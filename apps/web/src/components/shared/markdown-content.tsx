import { CommentVisual, isVisualLanguage } from '@/components/activity/comment-visual'
import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { remarkPlugins } from '@maskin/markdown/plugins'
import {
	Children,
	type ReactElement,
	type ReactNode,
	isValidElement,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { MentionedText } from './mentioned-text'

function wrapWithMentions(
	children: ReactNode,
	actors: ActorListItem[],
	onMentionClick?: (actor: ActorListItem) => void,
): ReactNode {
	if (typeof children === 'string') {
		return <MentionedText content={children} actors={actors} onMentionClick={onMentionClick} />
	}
	if (Array.isArray(children)) {
		const mentionProps = { actors, onMentionClick }
		return children.map((child, idx) =>
			typeof child === 'string' ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: children come from a deterministic markdown AST; order is stable across renders
				<MentionedText key={`m-${idx}`} content={child} {...mentionProps} />
			) : (
				child
			),
		)
	}
	return children
}

/**
 * Extracts the language hint (e.g. "chart") from the `language-X` className
 * react-markdown puts on the inner `<code>` of a fenced block.
 */
function readCodeLanguage(child: ReactNode): string | undefined {
	if (!isValidElement(child)) return undefined
	const childEl = child as ReactElement<{ className?: string }>
	const className = childEl.props?.className
	if (typeof className !== 'string') return undefined
	const match = className.match(/language-([\w-]+)/)
	return match?.[1]
}

function readCodeSource(child: ReactNode): string {
	if (!isValidElement(child)) return ''
	const childEl = child as ReactElement<{ children?: ReactNode }>
	const inner = childEl.props?.children
	if (typeof inner === 'string') return inner
	if (Array.isArray(inner)) return inner.filter((c): c is string => typeof c === 'string').join('')
	return ''
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
	renderVisuals = false,
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	/** `doc` is the v2 document scale a detail page's body renders at (mockup
	 *  1105–1122): a 15px lead paragraph, 12.5px bold micro-headings, 14px/1.65
	 *  running copy, and em-dash list markers. */
	size?: 'sm' | 'xs' | 'doc'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
	/**
	 * Opt-in: when true, fenced blocks tagged ```chart render as inline visuals
	 * (e.g. recharts). Defaults to false so object-document body markdown is
	 * unaffected — only ActivityComment opts in.
	 */
	renderVisuals?: boolean
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

		// When renderVisuals is on, override <pre> (not just <code>) so the
		// dispatched visual replaces the whole block — react-markdown wraps fenced
		// blocks as <pre><code class="language-X">…</code></pre> and a <div>
		// child inside <pre> is invalid HTML.
		const pre: Components['pre'] = ({ children, ...rest }) => {
			if (renderVisuals) {
				const first = Children.toArray(children).find((c) => isValidElement(c)) as
					| ReactElement
					| undefined
				const lang = readCodeLanguage(first)
				if (lang && isVisualLanguage(lang)) {
					return <CommentVisual language={lang} source={readCodeSource(first)} />
				}
			}
			return <pre {...rest}>{children}</pre>
		}

		if (!mentionActors) return { code, pre }
		const wrap = (children: ReactNode) => wrapWithMentions(children, mentionActors, onMentionClick)
		return {
			code,
			pre,
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
	}, [mentionActors, onMentionClick, renderVisuals])

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
					size === 'doc' && [
						'[&_p]:text-sm [&_p]:leading-[1.65] [&_p]:text-foreground [&_p]:mb-2 [&_p]:mt-0',
						'[&>p:first-child]:text-[15px] [&>p:first-child]:mb-4',
						'[&_h1]:text-[12.5px] [&_h2]:text-[12.5px] [&_h3]:text-[12.5px] [&_h4]:text-[12.5px]',
						'[&_:is(h1,h2,h3,h4)]:font-bold [&_:is(h1,h2,h3,h4)]:tracking-[-0.01em] [&_:is(h1,h2,h3,h4)]:mb-[7px] [&_:is(h1,h2,h3,h4)]:mt-[19px]',
						'[&_li]:text-[13px] [&_li]:leading-[1.6] [&_li]:text-foreground [&_li]:my-0',
						"[&_ul]:list-none [&_ul]:pl-0 [&_ul]:my-0 [&_ul]:mb-2.5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-[5px] [&_ul>li]:relative [&_ul>li]:pl-[22px] [&_ul>li]:before:absolute [&_ul>li]:before:left-0 [&_ul>li]:before:text-border-strong [&_ul>li]:before:content-['—']",
					],
				)}
			>
				<ReactMarkdown
					remarkPlugins={remarkPlugins as unknown as never[]}
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
