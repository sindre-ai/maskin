import { Textarea } from '@/components/ui/textarea'
import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Check, Copy } from 'lucide-react'
import { Highlight, themes } from 'prism-react-renderer'
import {
	type ReactNode,
	isValidElement,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
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

export function MarkdownContent({
	content,
	onChange,
	editable = false,
	className,
	size = 'sm',
	disallowedElements,
	mentionActors,
	onMentionClick,
}: {
	content: string
	onChange?: (value: string) => void
	editable?: boolean
	className?: string
	size?: 'sm' | 'xs'
	disallowedElements?: string[]
	mentionActors?: ActorListItem[]
	onMentionClick?: (actor: ActorListItem) => void
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

		// Fenced code blocks (` ```ts ... ``` `) come through ReactMarkdown as a
		// `<pre>` wrapping a `<code class="language-…">`. Replace `pre` so we can
		// render the highlighted output via prism-react-renderer with a per-block
		// copy button — without losing the inline `code` behaviour above.
		const pre: Components['pre'] = ({ children }) => {
			const extracted = extractCodeBlock(children)
			if (!extracted) {
				return <pre>{children}</pre>
			}
			return <CodeBlock language={extracted.language} code={extracted.code} />
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
	}, [mentionActors, onMentionClick])

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

function extractCodeBlock(children: ReactNode): { language: string; code: string } | null {
	if (!isValidElement(children)) return null
	const props = children.props as { className?: string; children?: ReactNode } | undefined
	if (!props) return null
	const language = parseLanguage(props.className) ?? 'text'
	const code = extractText(props.children)
	if (code.length === 0) return null
	return { language, code }
}

function parseLanguage(className: string | undefined): string | null {
	if (!className) return null
	const match = /language-([\w-]+)/.exec(className)
	return match ? match[1] : null
}

function extractText(node: ReactNode): string {
	if (node == null || typeof node === 'boolean') return ''
	if (typeof node === 'string') return node
	if (typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(extractText).join('')
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode } | undefined
		return extractText(props?.children)
	}
	return ''
}

function CodeBlock({ language, code }: { language: string; code: string }) {
	const [copied, setCopied] = useState(false)
	const trimmed = code.replace(/\n$/, '')

	const handleCopy = useCallback(async () => {
		if (typeof navigator === 'undefined' || !navigator.clipboard) return
		try {
			await navigator.clipboard.writeText(trimmed)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// Clipboard write can reject in headless / unfocused contexts. Leave
			// the button in its idle state so the user can retry.
		}
	}, [trimmed])

	return (
		<div className="group relative not-prose my-3 overflow-hidden rounded-md border border-border bg-bg">
			<div className="flex items-center justify-between border-b border-border px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted">
				<span>{language === 'text' ? '' : language}</span>
				<button
					type="button"
					onClick={handleCopy}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-text-secondary opacity-0 transition-opacity hover:bg-bg-hover focus:opacity-100 group-hover:opacity-100"
					aria-label={copied ? 'Copied' : 'Copy code'}
				>
					{copied ? <Check size={12} /> : <Copy size={12} />}
					<span>{copied ? 'Copied' : 'Copy'}</span>
				</button>
			</div>
			<Highlight code={trimmed} language={language} theme={themes.vsDark}>
				{({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => (
					<pre
						className={cn(prismClassName, 'overflow-x-auto px-3 py-2 text-xs leading-relaxed')}
						style={style}
					>
						{tokens.map((line, lineIndex) => {
							const lineProps = getLineProps({ line })
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: token line index is stable for a given code string
								<div key={lineIndex} {...lineProps}>
									{line.map((token, tokenIndex) => {
										const tokenProps = getTokenProps({ token })
										// biome-ignore lint/suspicious/noArrayIndexKey: token position within a line is stable for a given code string
										return <span key={tokenIndex} {...tokenProps} />
									})}
								</div>
							)
						})}
					</pre>
				)}
			</Highlight>
		</div>
	)
}
