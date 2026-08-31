import { Children, type ReactElement, type ReactNode, isValidElement, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { remarkPlugins } from '../plugins'
import { type MentionActor, MentionedText } from './mentioned-text'

export type MarkdownRendererSize = 'sm' | 'xs' | 'doc'

/**
 * Optional slot for rendering fenced code blocks with a custom node — used by
 * the `apps/web` visualiser to swap ```chart blocks for an inline recharts
 * widget without pulling recharts (or knowledge of chart specs) into this
 * package. Return `undefined` to fall back to the default `<pre><code>`.
 */
export interface RenderCodeBlockArgs {
	language: string | undefined
	source: string
}

export interface RenderImageArgs {
	src: string | undefined
	alt: string | undefined
	title: string | undefined
}

export interface MarkdownRendererProps {
	content: string
	className?: string
	size?: MarkdownRendererSize
	disallowedElements?: string[]
	/**
	 * Whether children of `disallowedElements` are rendered in place of the
	 * disallowed wrapper. Defaults to `true` when `disallowedElements` is
	 * non-empty (matches today's `MarkdownContent` behaviour).
	 */
	unwrapDisallowed?: boolean
	mentionActors?: MentionActor[]
	onMentionClick?: (actor: MentionActor) => void
	/**
	 * When true, fenced blocks are handed to `renderCodeBlock`. Defaults to
	 * false so read paths that don't opt in stay on the plain `<pre>` path.
	 */
	renderVisuals?: boolean
	/** Injected renderer for fenced code blocks — required for `renderVisuals`. */
	renderCodeBlock?: (args: RenderCodeBlockArgs) => ReactNode | undefined
	/**
	 * Injected renderer for images — lets `apps/web` swap maskin file-viewer
	 * URLs for the file's own bytes (an app data hook this package must not
	 * import). Return `undefined` to fall back to a plain `<img>`.
	 */
	renderImage?: (args: RenderImageArgs) => ReactNode | undefined
}

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

function wrapWithMentions(
	children: ReactNode,
	actors: MentionActor[],
	onMentionClick?: (actor: MentionActor) => void,
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

const DEFAULT_PROSE_CLASS =
	'prose dark:prose-invert prose-sm max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-p:leading-[1.7142857] prose-li:text-muted-foreground prose-a:text-primary prose-strong:text-foreground prose-code:text-primary prose-code:bg-card prose-code:px-1 prose-code:rounded prose-code:before:content-none prose-code:after:content-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_img]:max-w-full'
const XS_PROSE_CLASS = '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs'
// The v2 document scale a detail page's body renders at: a 15px lead paragraph,
// 12.5px bold micro-headings, 14px/1.65 running copy, and em-dash list markers.
const DOC_PROSE_CLASS = [
	'[&_p]:text-[15px] [&_p]:leading-[1.65] [&_p]:text-foreground [&_p]:mb-2 [&_p]:mt-0',
	'[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px] [&_h4]:text-[13px]',
	'[&_:is(h1,h2,h3,h4)]:font-bold [&_:is(h1,h2,h3,h4)]:tracking-[-0.01em] [&_:is(h1,h2,h3,h4)]:mb-1 [&_:is(h1,h2,h3,h4)]:mt-3.5',
	'[&_li]:text-sm [&_li]:leading-[1.6] [&_li]:text-foreground [&_li]:my-0',
	"[&_ul]:list-none [&_ul]:pl-0 [&_ul]:my-0 [&_ul]:mb-2.5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-[5px] [&_ul>li]:relative [&_ul>li]:pl-[22px] [&_ul>li]:before:absolute [&_ul>li]:before:left-0 [&_ul>li]:before:text-border-strong [&_ul>li]:before:content-['—']",
].join(' ')

/**
 * Read-only markdown surface. Ships on every read path (feeds, notifications,
 * marketing) and MUST NOT pull Tiptap into the bundle — that split is what
 * keeps read routes at ~55KB gzip instead of ~235KB.
 */
export function MarkdownRenderer({
	content,
	className,
	size = 'sm',
	disallowedElements,
	unwrapDisallowed,
	mentionActors,
	onMentionClick,
	renderVisuals = false,
	renderCodeBlock,
	renderImage,
}: MarkdownRendererProps) {
	const components = useMemo<Components>(() => {
		const code: Components['code'] = ({ children, className: codeClass }) => {
			// Inline code spans that hold nothing but a bare URL render as a
			// clickable link — agents write URLs in backticks and the
			// remark-breaks + remark-gfm combination doesn't always autolink.
			if (!codeClass) {
				const text = typeof children === 'string' ? children.trim() : ''
				if (!text.includes('\n') && /^https?:\/\/\S+$/.test(text)) {
					return (
						<a href={text} target="_blank" rel="noopener noreferrer">
							{text}
						</a>
					)
				}
			}
			return <code className={codeClass}>{children}</code>
		}

		// Override <pre> (not just <code>) so an injected node fully replaces the
		// fenced block — react-markdown wraps fenced blocks as
		// <pre><code class="language-X">…</code></pre> and a <div> inside <pre> is
		// invalid HTML.
		const pre: Components['pre'] = ({ children, ...rest }) => {
			if (renderVisuals && renderCodeBlock) {
				const first = Children.toArray(children).find((c) => isValidElement(c)) as
					| ReactElement
					| undefined
				const language = readCodeLanguage(first)
				const source = readCodeSource(first)
				const rendered = renderCodeBlock({ language, source })
				if (rendered !== undefined) return <>{rendered}</>
			}
			return <pre {...rest}>{children}</pre>
		}

		// `overflow-x-auto` on a `<table>` doesn't clamp the way it does on a block
		// box — the table layout algorithm still computes its intrinsic width from
		// cell content and can exceed the containing block. An outer block-level
		// scroll wrapper is the reliable pattern for wide tables.
		const table: Components['table'] = ({ children, ...rest }) => (
			<div className="my-2 max-w-full overflow-x-auto">
				<table {...rest}>{children}</table>
			</div>
		)

		const img: Components['img'] = ({ src, alt, title }) => {
			const rendered = renderImage?.({
				src: typeof src === 'string' ? src : undefined,
				alt,
				title,
			})
			if (rendered !== undefined) return <>{rendered}</>
			return <img src={src} alt={alt ?? ''} title={title} />
		}

		// Markdown links open in a new tab so a click never navigates the app away
		// from the page you are on — mirrors the inline-code-URL path above. Hash
		// and relative links keep default behaviour so in-page anchors still work.
		const link =
			(wrapChildren?: (children: ReactNode) => ReactNode): Components['a'] =>
			({ children, href, ...rest }) => {
				const external = typeof href === 'string' && /^https?:\/\//.test(href)
				return (
					<a
						{...rest}
						href={href}
						{...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
					>
						{wrapChildren ? wrapChildren(children) : children}
					</a>
				)
			}

		if (!mentionActors) return { code, img, pre, table, a: link() }
		const wrap = (children: ReactNode) => wrapWithMentions(children, mentionActors, onMentionClick)
		return {
			code,
			img,
			pre,
			table,
			p: ({ children }) => <p>{wrap(children)}</p>,
			li: ({ children }) => <li>{wrap(children)}</li>,
			em: ({ children }) => <em>{wrap(children)}</em>,
			strong: ({ children }) => <strong>{wrap(children)}</strong>,
			blockquote: ({ children }) => <blockquote>{wrap(children)}</blockquote>,
			del: ({ children }) => <del>{wrap(children)}</del>,
			a: link(wrap),
			td: ({ children, ...rest }) => <td {...rest}>{wrap(children)}</td>,
			th: ({ children, ...rest }) => <th {...rest}>{wrap(children)}</th>,
		}
	}, [mentionActors, onMentionClick, renderVisuals, renderCodeBlock, renderImage])

	const proseClass =
		size === 'xs'
			? `${DEFAULT_PROSE_CLASS} ${XS_PROSE_CLASS}`
			: size === 'doc'
				? `${DEFAULT_PROSE_CLASS} ${DOC_PROSE_CLASS}`
				: DEFAULT_PROSE_CLASS

	const effectiveUnwrap =
		unwrapDisallowed ?? Boolean(disallowedElements && disallowedElements.length > 0)

	return (
		<div className={className}>
			<div className={proseClass}>
				<ReactMarkdown
					remarkPlugins={remarkPlugins as unknown as never[]}
					disallowedElements={disallowedElements}
					unwrapDisallowed={effectiveUnwrap}
					components={components}
				>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	)
}
