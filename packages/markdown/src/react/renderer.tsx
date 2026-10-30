import { Children, type ReactElement, type ReactNode, isValidElement, useMemo } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import { remarkPlugins } from '../plugins'
import { type MentionActor, MentionedText } from './mentioned-text'
import { MARKDOWN_PROSE_CLASS } from './prose'

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

export interface ComponentOverridesContext {
	/**
	 * Wraps text children so @mentions render inside them. The identity when
	 * `mentionActors` is not set, so an override can call it unconditionally.
	 */
	wrap: (children: ReactNode) => ReactNode
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
	/** Ids the author tagged; those mentions draw as the brand chip. See MentionedText. */
	taggedActorIds?: string[]
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
	/**
	 * Extra rehype plugins, run after the built-in remark plugins. Lets
	 * `apps/web` annotate the tree (for example to place chat cards) without
	 * this package knowing about them. Keep the array's identity stable.
	 */
	rehypePlugins?: Options['rehypePlugins']
	/**
	 * Injected component overrides, merged over the defaults (including the
	 * mention-wrapping ones). Lets `apps/web` draw app-only elements such as
	 * chat cards. Keep its identity stable (`useCallback`), or every render
	 * rebuilds the component map and remounts what it draws.
	 */
	getComponentOverrides?: (context: ComponentOverridesContext) => Components
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
	taggedActorIds?: string[],
): ReactNode {
	const mentionProps = { actors, onMentionClick, taggedActorIds }
	if (typeof children === 'string') {
		return <MentionedText content={children} {...mentionProps} />
	}
	if (Array.isArray(children)) {
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

const XS_PROSE_CLASS = '[&_p]:text-xs [&_p]:leading-normal [&_li]:text-xs [&_a]:text-xs'
// The v2 document scale a detail page's body renders at: a 15px lead paragraph,
// 12.5px bold micro-headings and 14px/1.65 running copy. List markers come from
// the shared prose class.
const DOC_PROSE_CLASS = [
	'[&_p]:text-[15px] [&_p]:leading-[1.65] [&_p]:text-foreground [&_p]:mb-2 [&_p]:mt-0',
	'[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px] [&_h4]:text-[13px]',
	'[&_:is(h1,h2,h3,h4)]:font-bold [&_:is(h1,h2,h3,h4)]:tracking-[-0.01em] [&_:is(h1,h2,h3,h4)]:mb-1 [&_:is(h1,h2,h3,h4)]:mt-3.5',
	'[&_li]:text-sm [&_li]:leading-[1.6] [&_li]:text-foreground [&_li]:my-0',
	'[&_ul]:my-0 [&_ul]:mb-2.5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-[5px]',
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
	taggedActorIds,
	renderVisuals = false,
	renderCodeBlock,
	renderImage,
	rehypePlugins,
	getComponentOverrides,
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

		const wrap = (children: ReactNode) =>
			mentionActors
				? wrapWithMentions(children, mentionActors, onMentionClick, taggedActorIds)
				: children
		const overrides = getComponentOverrides?.({ wrap })
		if (!mentionActors) return { code, img, pre, table, a: link(), ...overrides }
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
			...overrides,
		}
	}, [
		mentionActors,
		onMentionClick,
		taggedActorIds,
		renderVisuals,
		renderCodeBlock,
		renderImage,
		getComponentOverrides,
	])

	const proseClass =
		size === 'xs'
			? `${MARKDOWN_PROSE_CLASS} ${XS_PROSE_CLASS}`
			: size === 'doc'
				? `${MARKDOWN_PROSE_CLASS} ${DOC_PROSE_CLASS}`
				: MARKDOWN_PROSE_CLASS

	const effectiveUnwrap =
		unwrapDisallowed ?? Boolean(disallowedElements && disallowedElements.length > 0)

	return (
		<div className={className}>
			<div className={proseClass}>
				<ReactMarkdown
					remarkPlugins={remarkPlugins as unknown as never[]}
					disallowedElements={disallowedElements}
					unwrapDisallowed={effectiveUnwrap}
					rehypePlugins={rehypePlugins}
					components={components}
				>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	)
}
