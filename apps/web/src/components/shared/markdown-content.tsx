import { CommentVisual, isVisualLanguage } from '@/components/activity/comment-visual'
import { EditorBanner } from '@/components/shared/editor-banner'
import { useFile } from '@/hooks/use-files'
import type { ActorListItem } from '@/lib/api'
import { captureEditorParseError, editorTelemetry } from '@/lib/editor-events'
import {
	type GithubTarget,
	type HastNode,
	LINKED_CARDS_TAG,
	type LinkedTarget,
	type SettingsTarget,
	type StandaloneCard,
	githubTargetOf,
	placeLinkedCards,
	settingsTargetOf,
	targetOfHref,
} from '@/lib/linked-objects'
import {
	type ComponentOverridesContext,
	MarkdownRenderer,
	type MentionActor,
	type RenderCodeBlockArgs,
	type RenderImageArgs,
} from '@maskin/markdown/react'
import type {
	MarkdownParseErrorInfo,
	SavedInfo,
	ShortcutInfo,
	ToolbarActionInfo,
} from '@maskin/markdown/react/editor'
import {
	Fragment,
	type ReactNode,
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { Components } from 'react-markdown'

// Dynamic-imported so Tiptap never bundles into a read-only route — read paths
// (feeds, notifications, marketing) never touch this chunk. The Vite chunk-
// name CI assertion (`apps/web/scripts/assert-editor-chunk.mjs`) enforces the
// split at build time. See tech spec §12 rabbit hole #6.
const MarkdownEditor = lazy(() =>
	import('@/components/shared/document-markdown-editor').then((m) => ({
		default: m.DocumentMarkdownEditor,
	})),
)

const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FILE_VIEWER_PATH_RE = new RegExp(`^/(${UUID_RE_SRC})/files/(${UUID_RE_SRC})/?$`, 'i')

/**
 * Extracts workspace + file ids from a maskin file viewer URL like
 * `https://maskin.io/<workspaceId>/files/<fileId>`. The viewer URL is what
 * `fileViewerUrl()` mints and what agents paste into markdown descriptions —
 * but it points at an HTML page, not the image bytes, so `<img src>` for it
 * loads an HTML document and renders as broken. Callers use this to detect
 * and swap the URL for a data-URI derived from the file's own base64 content.
 */
export function parseFileViewerUrl(
	src: string | undefined,
): { workspaceId: string; fileId: string } | null {
	if (!src) return null
	let pathname: string
	try {
		pathname = new URL(src, 'http://x').pathname
	} catch {
		return null
	}
	const match = FILE_VIEWER_PATH_RE.exec(pathname)
	if (!match) return null
	return { workspaceId: match[1].toLowerCase(), fileId: match[2].toLowerCase() }
}

// MIME types whose bytes must never be rendered as `<img src>` — same closed
// list as `apps/web/src/components/files/file-body.tsx`'s `UNSAFE_INLINE_MIME`.
// SVG in particular can carry inline scripts and event handlers.
const UNSAFE_IMG_MIME = new Set([
	'text/html',
	'application/xhtml+xml',
	'image/svg+xml',
	'application/javascript',
	'text/javascript',
	'application/ecmascript',
	'text/ecmascript',
])

function FileViewerImage({
	workspaceId,
	fileId,
	alt,
	title,
}: {
	workspaceId: string
	fileId: string
	alt?: string
	title?: string
}) {
	const { data, isError } = useFile(workspaceId, fileId)
	if (
		isError ||
		(data && (!data.mimeType.startsWith('image/') || UNSAFE_IMG_MIME.has(data.mimeType)))
	) {
		// Not an inline-safe image (a PDF, an SVG, a fetch failure): fall back
		// to a link so the URL is still reachable rather than a silent broken img.
		return (
			<a href={`/${workspaceId}/files/${fileId}`} title={title}>
				{alt || 'file'}
			</a>
		)
	}
	if (!data) return <img alt={alt ?? ''} title={title} />
	const b64 = data.encoding === 'base64' ? data.content : btoa(data.content)
	return <img src={`data:${data.mimeType};base64,${b64}`} alt={alt ?? ''} title={title} />
}

// An <img src> pointing at a maskin file viewer URL (/<workspaceId>/files/<fileId>)
// loads an HTML viewer page as bytes and renders as broken. Swap it for a
// component that fetches the file and inlines its bytes as a data-URI — mirrors
// apps/web/src/components/files/file-body.tsx's inline-image path. Injected into
// the package renderer because useFile is an app data hook.
function renderMarkdownImage({ src, alt, title }: RenderImageArgs) {
	const parsed = parseFileViewerUrl(src)
	if (!parsed) return undefined
	return (
		<FileViewerImage
			workspaceId={parsed.workspaceId}
			fileId={parsed.fileId}
			alt={alt}
			title={title}
		/>
	)
}

// Fenced chart blocks render as inline visuals; injected for the same reason.
function renderChartBlock({ language, source }: RenderCodeBlockArgs) {
	if (language && isVisualLanguage(language)) {
		return <CommentVisual language={language} source={source} />
	}
	return undefined
}

/**
 * Where a message's links to objects and files turn into cards and chips. A link that stands
 * alone on its line, or alone in a list item, is replaced by its card in place. Any other link to
 * an object is a chip where it stands; a draft or file linked in a sentence gets its card under
 * the text. An id drawn in place is never drawn again.
 */
export interface LinkedCardsOptions {
	workspaceId: string
	/** The chat the message is in and the agent that wrote it; they let a card tell that agent. */
	conversationId?: string
	agentId?: string
	/** Ids whose card another message in the chat holds: their links here are chips. */
	skipIds?: ReadonlySet<string>
	/** Ids of drafts edited since an earlier message showed them: their card carries an Updated tag. */
	updatedIds?: ReadonlySet<string>
	/**
	 * Draws the card for a link, or `fallback` when it deserves none. Passed in rather than
	 * imported because the cards render markdown themselves. Keep its identity stable.
	 */
	renderCard: (
		target: LinkedTarget,
		fallback: ReactNode,
		context: {
			workspaceId: string
			conversationId?: string
			agentId?: string
			label?: string
			inList?: boolean
			/** The card goes under the sentence that links it: only a draft is drawn, never a reference. */
			after?: boolean
			/** A draft edited since an earlier message showed it: the card says so. */
			updated?: boolean
		},
	) => ReactNode
	/**
	 * Draws a link to an object that is not replaced by a card as a chip, or `fallback` (the
	 * original link) while it cannot. Keep its identity stable.
	 */
	renderChip?: (
		target: LinkedTarget,
		fallback: ReactNode,
		context: {
			workspaceId: string
			/** A draft's card is drawn under the sentence, so its link stays plain; false: it is a chip. */
			cardFollows?: boolean
		},
	) => ReactNode
	/**
	 * Draws a link to a GitHub pull request or issue as a chip built from the address alone, in a
	 * sentence or alone on a line. Without it such a link stays a plain link. Keep its identity stable.
	 */
	renderGithubChip?: (target: GithubTarget, href: string) => ReactNode
	/**
	 * Draws a link to a settings page of this workspace as a chip built from the address alone, in a
	 * sentence or alone on a line. Without it such a link stays a plain link. Keep its identity stable.
	 */
	renderSettingsChip?: (target: SettingsTarget, context: { workspaceId: string }) => ReactNode
}

// Decides where every linked card goes (see `placeLinkedCards`) before the tree is rendered.
function placeCardsPlugin(skipIds: ReadonlySet<string> | undefined) {
	return () => (tree: HastNode) => placeLinkedCards(tree, skipIds)
}

// A list item holding a card gives up its bullet (a numbered one keeps its number, so the
// count does not skip). `data-linked-card` is on the card's root.
const CARD_ITEM_CLASS =
	'[ul>&]:has-[>[data-linked-card]]:list-none [ul>&]:has-[>[data-linked-card]]:before:hidden'

type MarkdownContentProps = {
	content: string
	// May return a promise; it is called on blur with the editor's markdown.
	onChange?: (value: string) => unknown
	editable?: boolean
	className?: string
	/** `doc` is the v2 document scale a detail page's body renders at (mockup
	 *  1105–1122): a 15px lead paragraph, 12.5px bold micro-headings, 14px/1.65
	 *  running copy, and em-dash list markers. Read-only rendering only. */
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
	/** Accessible name for the editing field. */
	editorLabel?: string
	/**
	 * Opt-in, for chat messages: links to drafts and previewable files become cards, in place
	 * where the link stands alone and under the text where it sits in a sentence. Without it
	 * the markdown renders exactly as before.
	 */
	linkedCards?: LinkedCardsOptions
	/**
	 * Editor only. Treat `content` as stored text to protect: a save rewrites
	 * only the blocks the person touched, and text the editor cannot hold safely
	 * opens read-only.
	 */
	preserveSource?: boolean
	/** Editor only. Surface name carried on the editor events. */
	surface?: string
	objectId?: string
}

function RenderedMarkdownContent({
	content,
	className,
	size = 'sm',
	disallowedElements,
	mentionActors,
	onMentionClick,
	renderVisuals = false,
	linkedCards: linkedCardsOption,
}: Omit<
	MarkdownContentProps,
	'onChange' | 'editable' | 'editorLabel' | 'preserveSource' | 'surface' | 'objectId'
>) {
	// Keyed on the values, not the object: a caller passing a fresh literal each render must not
	// change the component map, or every card in the message would remount.
	const cardsWorkspaceId = linkedCardsOption?.workspaceId
	const cardsConversationId = linkedCardsOption?.conversationId
	const cardsAgentId = linkedCardsOption?.agentId
	const cardsRenderer = linkedCardsOption?.renderCard
	const chipRenderer = linkedCardsOption?.renderChip
	const githubChipRenderer = linkedCardsOption?.renderGithubChip
	const settingsChipRenderer = linkedCardsOption?.renderSettingsChip
	const cardsSkipIds = linkedCardsOption?.skipIds
	// By value, like the rest: a fresh set with the same ids must not remount the cards.
	const cardsUpdatedKey = linkedCardsOption?.updatedIds
		? [...linkedCardsOption.updatedIds].sort().join(',')
		: ''
	const linkedCards = useMemo<LinkedCardsOptions | undefined>(
		() =>
			cardsWorkspaceId && cardsRenderer
				? {
						workspaceId: cardsWorkspaceId,
						conversationId: cardsConversationId,
						agentId: cardsAgentId,
						updatedIds: cardsUpdatedKey ? new Set(cardsUpdatedKey.split(',')) : undefined,
						renderCard: cardsRenderer,
						renderChip: chipRenderer,
						renderGithubChip: githubChipRenderer,
						renderSettingsChip: settingsChipRenderer,
					}
				: undefined,
		[
			cardsWorkspaceId,
			cardsConversationId,
			cardsAgentId,
			cardsRenderer,
			chipRenderer,
			cardsUpdatedKey,
			githubChipRenderer,
			settingsChipRenderer,
		],
	)
	// With linkedCards on, a paragraph or list item that is only a link renders as its card, and
	// any other link to an object as a chip; the original element is what shows until the card or
	// chip is known to apply, so a link never vanishes.
	const getComponentOverrides = useMemo(() => {
		if (!linkedCards) return undefined
		const withCard = (node: unknown, original: ReactNode, bare: ReactNode): ReactNode => {
			const card = (node as HastNode | undefined)?.data?.linkedCard as StandaloneCard | undefined
			if (!card) return original
			return linkedCards.renderCard(card.target, card.bare ? bare : original, {
				...linkedCards,
				label: card.label ?? undefined,
				inList: card.inList,
				updated: linkedCards.updatedIds?.has(card.target.id),
			})
		}
		return ({ wrap }: ComponentOverridesContext) =>
			({
				p: ({ node, children }: { node?: HastNode; children?: ReactNode }) =>
					withCard(node, <p>{wrap(children)}</p>, wrap(children)),
				li: ({ children }: { children?: ReactNode }) => (
					<li className={CARD_ITEM_CLASS}>{wrap(children)}</li>
				),
				a: ({
					node,
					href,
					children,
					...rest
				}: { node?: HastNode; href?: string; children?: ReactNode } & Record<string, unknown>) => {
					const github = githubTargetOf(href)
					if (github && linkedCards.renderGithubChip && href) {
						return linkedCards.renderGithubChip(github, href)
					}
					const settings = linkedCards.renderSettingsChip
						? settingsTargetOf(href, linkedCards.workspaceId)
						: null
					if (settings && linkedCards.renderSettingsChip) {
						return linkedCards.renderSettingsChip(settings, linkedCards)
					}
					// Same as the renderer's own link: an address on the web opens in a new tab.
					const external = typeof href === 'string' && /^https?:\/\//.test(href)
					const link = (
						<a
							{...rest}
							href={href}
							{...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
						>
							{wrap(children)}
						</a>
					)
					const target = node?.data?.linkedChip ? targetOfHref(href) : null
					return target && linkedCards.renderChip
						? linkedCards.renderChip(target, link, {
								...linkedCards,
								cardFollows: node?.data?.cardFollows !== false,
							})
						: link
				},
				[LINKED_CARDS_TAG]: ({ node }: { node?: HastNode }) => {
					const list = (key: string) =>
						String(node?.properties?.[key] ?? '')
							.split(',')
							.filter(Boolean)
					return (
						<>
							{list('objects').map((id) => (
								<Fragment key={`object:${id}`}>
									{linkedCards.renderCard({ kind: 'object', id }, null, {
										...linkedCards,
										after: true,
										updated: linkedCards.updatedIds?.has(id),
									})}
								</Fragment>
							))}
							{list('files').map((id) => (
								<Fragment key={`file:${id}`}>
									{linkedCards.renderCard({ kind: 'file', id }, null, linkedCards)}
								</Fragment>
							))}
						</>
					)
				},
			}) as unknown as Components
	}, [linkedCards])
	const rehypePlugins = useMemo(
		() => (linkedCards ? [placeCardsPlugin(cardsSkipIds)] : undefined),
		[linkedCards, cardsSkipIds],
	)

	return (
		<div className={className}>
			<MarkdownRenderer
				content={content}
				size={size}
				disallowedElements={disallowedElements}
				mentionActors={mentionActors as MentionActor[] | undefined}
				onMentionClick={onMentionClick as ((actor: MentionActor) => void) | undefined}
				renderVisuals={renderVisuals}
				renderCodeBlock={renderChartBlock}
				renderImage={renderMarkdownImage}
				rehypePlugins={rehypePlugins as unknown as never[] | undefined}
				getComponentOverrides={getComponentOverrides}
			/>
		</div>
	)
}

/**
 * Thin adapter over the split @maskin/markdown/react package (bet 666e3c4a).
 *
 * - editable=false: MarkdownRenderer (react-markdown, 0 KB added on read
 *   routes), reached through RenderedMarkdownContent.
 * - editable=true: MarkdownEditor from the dynamic-imported Tiptap chunk.
 *
 * Blur-emit save semantics: onChange(markdown) fires only on blur (tech spec §9).
 */
export function MarkdownContent({
	editable,
	onChange,
	editorLabel,
	preserveSource,
	surface,
	objectId,
	...renderProps
}: MarkdownContentProps) {
	if (editable) {
		return (
			<EditorAdapter
				content={renderProps.content}
				onChange={onChange}
				className={renderProps.className}
				editorLabel={editorLabel}
				disallowedElements={renderProps.disallowedElements}
				preserveSource={preserveSource}
				surface={surface}
				objectId={objectId}
			/>
		)
	}

	return <RenderedMarkdownContent {...renderProps} />
}

export const READ_ONLY_DESCRIPTION_BANNER =
	"This description is read-only here. Editing it could change parts you didn't touch."

// Same wording as the file editor's refused-rewrite banner, for a description.
export const REFUSED_DESCRIPTION_BANNER =
	"Part of this description can't be written back without losing something, so that part was left as it was. Your other changes are saved."

// Dynamic-imported Tiptap surface. Blur-emit is delegated to the
// editor itself (spec §9). While the chunk is fetching, render the raw
// markdown so nothing flashes empty. `surface` / `objectId` ride on the editor
// events; the object description and create form pass them.
function EditorAdapter({
	content,
	onChange,
	className,
	editorLabel,
	disallowedElements,
	preserveSource,
	surface,
	objectId,
}: {
	content: string
	onChange?: (value: string) => unknown
	className?: string
	editorLabel?: string
	disallowedElements?: string[]
	preserveSource?: boolean
	surface?: string
	objectId?: string
}) {
	const [readOnly, setReadOnly] = useState(false)
	const [rewriteRefused, setRewriteRefused] = useState(false)
	// The editor reads `value` once, at mount. With preserveSource it also builds
	// its block map from that text, so a change that did not come from this editor
	// (an agent edit landing over SSE) has to remount it, or the next blur would
	// save the old text over the new. Our own save echoing back, and a change
	// while the person is mid-edit, leave it alone.
	const dirtyRef = useRef(false)
	const settledTextRef = useRef(content)
	const [editorKey, setEditorKey] = useState(0)
	useEffect(() => {
		if (!preserveSource) return
		if (content === settledTextRef.current || dirtyRef.current) return
		settledTextRef.current = content
		setEditorKey((key) => key + 1)
	}, [content, preserveSource])

	const handleChange = useCallback(
		(markdown: string) => {
			dirtyRef.current = false
			// A save that comes out identical to what is stored (every rewrite was
			// refused, or the edit was undone) is not sent: it would only stamp an
			// edit on the object that nobody made.
			if (preserveSource && markdown === settledTextRef.current) return
			settledTextRef.current = markdown
			onChange?.(markdown)
		},
		[onChange, preserveSource],
	)

	const handleEdit = useCallback(() => {
		dirtyRef.current = true
	}, [])

	const handleParseError = useCallback((info: MarkdownParseErrorInfo) => {
		captureEditorParseError(info)
		if (info.reason === 'read_only_fallback') setReadOnly(true)
		if (info.reason === 'loss_check') setRewriteRefused(true)
	}, [])

	const handleToolbarAction = useCallback((info: ToolbarActionInfo) => {
		editorTelemetry(info).emitToolbarAction({ action: info.action })
	}, [])

	const handleShortcutUsed = useCallback((info: ShortcutInfo) => {
		editorTelemetry(info).emitShortcut({ shortcut: info.shortcut })
	}, [])

	const handleSaved = useCallback((info: SavedInfo) => {
		editorTelemetry(info).emitSaved({
			contentLength: info.contentLength,
			saveTrigger: info.saveTrigger,
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
		<>
			{readOnly && surface === 'description' && (
				<EditorBanner tone="info" className="mb-3">
					{READ_ONLY_DESCRIPTION_BANNER}
				</EditorBanner>
			)}
			{rewriteRefused && surface === 'description' && (
				<EditorBanner tone="danger" heading="Couldn't save your changes" className="mb-3">
					{REFUSED_DESCRIPTION_BANNER}
				</EditorBanner>
			)}
			<Suspense
				fallback={
					<div className={className}>
						<MarkdownRenderer content={content} />
					</div>
				}
			>
				<MarkdownEditor
					key={editorKey}
					value={content}
					onChange={handleChange}
					onEdit={handleEdit}
					variant="document"
					className={className}
					ariaLabel={editorLabel}
					disallowedNodes={disallowedNodes}
					onParseError={handleParseError}
					onToolbarAction={handleToolbarAction}
					onShortcutUsed={handleShortcutUsed}
					onSaved={handleSaved}
					preserveSource={preserveSource}
					surface={surface}
					objectId={objectId}
				/>
			</Suspense>
		</>
	)
}
