import {
	LinkedCardFace,
	UnavailableCard,
	UnavailableChip,
	typeIconColor,
	typeIconOf,
	typeTileClass,
} from '@/components/chat/linked-card-face'
import { LOOP_PILL_STYLES } from '@/components/loops/loop-pill'
import { loopActivityLine } from '@/components/loops/loop-row'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime, formatRelative } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TRIGGER_TYPE_ICON, describeTrigger } from '@/components/triggers/trigger-row'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useActors } from '@/hooks/use-actors'
import { useLinkedChat } from '@/hooks/use-linked-chat'
import { useLoop } from '@/hooks/use-loops'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject } from '@/hooks/use-objects'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { useTrigger } from '@/hooks/use-triggers'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { ACTIVE_STATUSES } from '@/lib/agent-status'
import type { ActorListItem, LoopSummary, ObjectResponse, TriggerResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	defaultStatusColor,
	defaultTypeColor,
	statusColors,
	statusLabel,
	typeColors,
} from '@/lib/constants'
import {
	type CardFact,
	type GithubTarget,
	type SettingsTarget,
	chatSummary,
	cutLabel,
	githubChipName,
	githubChipText,
	peopleLine,
	pickFacts,
	plainSnippet,
	settingsChipText,
	shortName,
	showsObjectCard,
} from '@/lib/linked-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import {
	ArrowUpRight,
	Bot,
	ChevronDown,
	ChevronUp,
	CircleDot,
	ExternalLink,
	GitPullRequest,
	Globe,
	Link2,
	MessageCircle,
	RefreshCw,
	Settings as SettingsIcon,
	Zap,
} from 'lucide-react'
import {
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	cloneElement,
	isValidElement,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { toast } from 'sonner'

/** The object in this workspace, or null while it loads (`undefined`) or when it is gone (`null`). */
function useLinkedObject(workspaceId: string, objectId: string) {
	const { data, isLoading } = useObject(objectId)
	const object: ObjectResponse | null | undefined = isLoading
		? undefined
		: data && data.workspaceId === workspaceId
			? data
			: null
	return object
}

/** The driver's name and kind, from the workspace's actor list (the lookup the chat already uses). */
function useDriver(workspaceId: string, object: ObjectResponse | null | undefined) {
	const { data: actors } = useActors(workspaceId, { enabled: true })
	if (!object?.driver) return { state: 'none' as const }
	const actor = actors?.find((a) => a.id === object.driver)
	if (actor) return { state: 'known' as const, actor }
	return { state: actors ? ('gone' as const) : ('loading' as const) }
}

const PREVIEW_WIDTH = 380
const PREVIEW_EDGE = 8

/** Marks the box a chip's preview must stay inside: the chat thread's scroller, which clips it. */
export const PREVIEW_BOUNDS_ATTR = 'data-chip-preview-bounds'

/** Where a preview opens: from the chip's left edge, from its right edge, or pinned to the pane. */
export type PreviewPlace =
	| { side: 'start' | 'end' }
	| { side: 'pinned'; left: number; width: number }

/**
 * Picks the first placement that keeps the card inside `bounds` with `PREVIEW_EDGE` to spare:
 * left-aligned to the chip, then right-aligned, and when neither fits the card is pinned to the
 * left of the bounds and shrunk to their width. `bounds` is the pane that holds the chip, or the
 * screen where there is no such pane.
 */
export function placePreview(
	chip: { left: number; right: number },
	bounds: { left: number; right: number },
	viewportWidth: number,
): PreviewPlace {
	const width = Math.min(PREVIEW_WIDTH, viewportWidth * 0.78)
	if (chip.left + width <= bounds.right - PREVIEW_EDGE) return { side: 'start' }
	if (chip.right - width >= bounds.left + PREVIEW_EDGE) return { side: 'end' }
	const room = bounds.right - bounds.left - 2 * PREVIEW_EDGE
	return { side: 'pinned', left: bounds.left + PREVIEW_EDGE, width: Math.min(width, room) }
}

/** The pane that clips a chip's preview, clamped to the screen; the whole screen without one. */
function previewBounds(chip: Element) {
	const screen = document.documentElement.clientWidth
	const pane = chip.closest(`[${PREVIEW_BOUNDS_ATTR}]`)
	if (!pane) return { left: 0, right: screen }
	const rect = pane.getBoundingClientRect()
	const left = rect.left + pane.clientLeft
	return { left: Math.max(0, left), right: Math.min(screen, left + pane.clientWidth) }
}

const PREVIEW_QUERY = '(min-width: 640px) and (hover: hover) and (pointer: fine)'

/** True on a pointer device at 640px or wider, the only place a chip opens a preview. */
function usePreviewCapable() {
	return useSyncExternalStore(
		(onChange) => {
			const mql = window.matchMedia(PREVIEW_QUERY)
			mql.addEventListener('change', onChange)
			return () => mql.removeEventListener('change', onChange)
		},
		() => window.matchMedia(PREVIEW_QUERY).matches,
		() => false,
	)
}

/** What the phone sheet of a chip holds and where its Open and Copy link buttons go. */
type ChipSheetContent = {
	/** The card, drawn as the sheet's face (see the cards' `sheet` prop). */
	card: ReactNode
	/** A link element to the target, without children; the sheet gives it the Open button's look. */
	openLink: ReactElement<{ className?: string; onClick?: () => void; children?: ReactNode }>
	/** The target's address in this workspace, for Copy link. */
	path: string
}

/** Copies the address of a target in this workspace. Without the clipboard API nothing is copied and no toast shows. */
async function copyLink(path: string) {
	try {
		await navigator.clipboard.writeText(`${window.location.origin}${path}`)
		toast('Link copied', { duration: 1800 })
	} catch {
		// No clipboard here.
	}
}

const PREVIEW_BUTTON =
	'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-border text-[11.5px] font-semibold text-foreground no-underline transition-colors duration-180 ease-standard hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** The preview's two buttons: Copy link (an icon) and Open. The same address the chip links to. */
function PreviewActions({ openLink, path }: Pick<ChipSheetContent, 'openLink' | 'path'>) {
	return (
		<span className="flex shrink-0 items-center gap-1.5">
			<button
				type="button"
				aria-label="Copy link"
				onClick={() => copyLink(path)}
				className={cn(PREVIEW_BUTTON, 'size-7 text-muted-foreground hover:text-foreground')}
			>
				<Link2 size={14} aria-hidden />
			</button>
			{cloneElement(
				openLink,
				{
					className: cn(
						PREVIEW_BUTTON,
						'border-transparent bg-primary px-2.5 text-primary-foreground hover:opacity-90',
					),
				},
				<ExternalLink size={12} aria-hidden />,
				'Open',
			)}
		</span>
	)
}

/**
 * Opens the card under its child while the pointer is over it or focus is inside it. The chip
 * wraps with the sentence, so this wrapper is inline too: the card opens under the chip's last
 * line, at the left edge of the chip's bounding box (the right edge when that would run off the
 * pane that holds the chat thread, or the screen; pinned to the pane and narrowed when neither
 * fits, see `placePreview`). The card is the one the chip stands for, read from the same cache entry,
 * so nothing is fetched here; while that entry loads the card shows its skeleton. It is a non-modal
 * dialog labelled "Object preview" with Copy link and Open in its footer: it opens on hover or when
 * the chip takes focus, Tab goes from the chip into Copy link and then Open, and Escape closes it and
 * puts focus back on the chip.
 *
 * Where there is no preview (below 640px, or on touch) a tap on the chip opens the same card in a
 * bottom sheet instead of leaving the chat, see `ChipSheet`.
 */
function ChipPreview({
	card,
	sheet,
	enabled,
	children,
}: {
	/** The card to open, drawn as a preview (see the cards' `preview` prop), given the buttons for its footer. */
	card: (actions: ReactNode) => ReactNode
	sheet: ChipSheetContent
	enabled: boolean
	children: ReactNode
}) {
	const capable = usePreviewCapable()
	const [open, setOpen] = useState(false)
	const [sheetOpen, setSheetOpen] = useState(false)
	const shown = open && enabled && capable
	const sheetShown = sheetOpen && enabled && !capable
	const root = useRef<HTMLSpanElement>(null)
	// The link that was tapped, so focus can go back to it when the sheet closes.
	const tapped = useRef<HTMLElement | null>(null)
	// The card is placed against the first and last line piece of the chip; `shift` moves it to the
	// bounding box of all of them (nothing for a chip on one line).
	const [place, setPlace] = useState({ alignEnd: false, shift: 0, width: 0 })

	useLayoutEffect(() => {
		if (shown && root.current) {
			const box = root.current.getBoundingClientRect()
			const pieces = root.current.getClientRects()
			const first = pieces[0]
			const last = pieces[pieces.length - 1]
			const where = placePreview(
				box,
				previewBounds(root.current),
				document.documentElement.clientWidth,
			)
			const alignEnd = where.side === 'end'
			setPlace({
				alignEnd,
				shift:
					first && last
						? where.side === 'pinned'
							? where.left - first.left
							: alignEnd
								? last.right - box.right
								: box.left - first.left
						: 0,
				width: where.side === 'pinned' ? where.width : 0,
			})
		}
	}, [shown])

	useEffect(() => {
		if (!shown) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			// Focus inside the preview goes back to the chip. (Focusing it opens the preview, so close after.)
			if (root.current?.contains(document.activeElement)) root.current.querySelector('a')?.focus()
			setOpen(false)
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [shown])

	// A tap on the chip's link opens the sheet and does not navigate.
	const onClickCapture = (e: MouseEvent) => {
		if (!enabled || capable) return
		const link = (e.target as Element).closest('a')
		if (!link || !root.current?.contains(link)) return
		e.preventDefault()
		e.stopPropagation()
		tapped.current = link
		setSheetOpen(true)
	}

	return (
		<>
			<span
				ref={root}
				className="relative"
				onClickCapture={onClickCapture}
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
				onFocus={() => setOpen(true)}
				onBlur={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
				}}
			>
				{children}
				{shown ? (
					// The top padding bridges the gap so the pointer can travel from chip to card.
					// biome-ignore lint/a11y/useSemanticElements: a non-modal popup anchored under the chip; native <dialog> is against project convention (apps/web/CLAUDE.md) and would need showModal or top-layer positioning
					<span
						role="dialog"
						aria-label="Object preview"
						data-linked-preview=""
						style={{
							...(place.alignEnd ? { right: place.shift } : { left: place.shift }),
							...(place.width ? { width: place.width } : null),
						}}
						className="absolute top-full z-50 block pt-1 chip-preview-rise"
					>
						{card(<PreviewActions openLink={sheet.openLink} path={sheet.path} />)}
					</span>
				) : null}
			</span>
			<ChipSheet
				open={sheetShown}
				onClose={() => setSheetOpen(false)}
				returnFocus={() => {
					const link = tapped.current?.isConnected
						? tapped.current
						: root.current?.querySelector('a')
					link?.focus()
				}}
				{...sheet}
			/>
		</>
	)
}

const SHEET_BUTTON =
	'inline-flex h-10 items-center justify-center rounded-lg border border-border text-[13px] font-semibold text-foreground transition-colors duration-180 ease-standard hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * The bottom sheet a tap on a chip opens below 640px or on touch, where there is no hover preview:
 * the chip's card (not a link), then Open, Copy link and Close. The status and owner a chip leaves
 * out are on the card, and the reader keeps their place in the chat. It is a modal dialog, so
 * focus moves in, Tab stays inside, Escape, the backdrop and Close shut it, and focus goes back to
 * the chip. Nothing is fetched: the card reads the chip's own cache entry.
 */
function ChipSheet({
	open,
	onClose,
	returnFocus,
	card,
	openLink,
	path,
}: ChipSheetContent & { open: boolean; onClose: () => void; returnFocus: () => void }) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent
				side="bottom"
				hideCloseButton
				aria-modal="true"
				aria-label="Object preview"
				aria-describedby={undefined}
				overlayClassName="bg-foreground/40 chip-sheet-fade"
				className="chip-sheet-rise flex flex-col gap-3 rounded-t-2xl bg-popover p-4 pb-6 motion-reduce:animate-none"
				onCloseAutoFocus={(e) => {
					e.preventDefault()
					returnFocus()
				}}
			>
				<SheetTitle className="sr-only">Object preview</SheetTitle>
				<span aria-hidden="true" className="mx-auto h-1 w-9 rounded-full bg-border-strong" />
				{card}
				<div className="mt-1 flex items-center gap-2">
					{cloneElement(
						openLink,
						{
							className:
								'inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-semibold text-primary-foreground no-underline transition-colors duration-180 ease-standard hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
							onClick: onClose,
						},
						<ExternalLink size={14} aria-hidden />,
						'Open',
					)}
					<button
						type="button"
						aria-label="Copy link"
						onClick={() => copyLink(path)}
						className={cn(SHEET_BUTTON, 'size-10 text-muted-foreground hover:text-foreground')}
					>
						<Link2 size={16} aria-hidden />
					</button>
					<SheetClose className={cn(SHEET_BUTTON, 'bg-background px-3.5')}>Close</SheetClose>
				</div>
			</SheetContent>
		</Sheet>
	)
}

// The chip is text: the size and line height of the sentence it sits in, a tinted plate that wraps
// with it (box-decoration-clone draws the plate on every line piece) and no vertical padding.
const CHIP =
	'not-prose rounded-md bg-muted px-[0.4em] font-medium text-foreground no-underline box-decoration-clone transition-colors duration-180 ease-standard hover:bg-brand-subtle hover:text-brand-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const CHIP_DOT = 'inline-block rounded-full bg-current align-middle'
const CHIP_ICON = 'mr-[0.4em] inline-block align-middle text-muted-foreground'
// A word joiner, for the dot of a chip that is still loading.
const JOIN = '\u2060'

/**
 * The text of a chip with its marks: `lead` stays on the first character and `trail` on the last,
 * so a dot never wraps onto a line of its own. Everything between breaks like words in a sentence.
 */
function ChipText({ lead, text, trail }: { lead?: ReactNode; text: string; trail?: ReactNode }) {
	const chars = Array.from(text)
	if (chars.length < 2) {
		return (
			<span className="whitespace-nowrap">
				{lead}
				{text}
				{trail}
			</span>
		)
	}
	return (
		<span>
			<span className="whitespace-nowrap">
				{lead}
				{chars[0]}
			</span>
			{chars.slice(1, -1).join('')}
			<span className="whitespace-nowrap">
				{chars[chars.length - 1]}
				{trail}
			</span>
		</span>
	)
}

/**
 * The chip of a link whose target is still loading: the author's own link, in the same plate and
 * at the sentence size, with a neutral dot that pulses (it holds still under reduced motion).
 */
function loadingChip(fallback: ReactNode, dot = true): ReactNode {
	if (!isValidElement(fallback)) return fallback
	const link = fallback as ReactElement<{ className?: string; children?: ReactNode }>
	return cloneElement(
		link,
		{ className: cn(link.props.className, CHIP) },
		dot ? (
			<span
				aria-hidden="true"
				className={cn(
					CHIP_DOT,
					'mr-[0.4em] size-[0.5em] text-muted-foreground motion-safe:animate-pulse',
				)}
			/>
		) : null,
		dot ? JOIN : null,
		<span>{link.props.children}</span>,
	)
}

/**
 * A link to an object inside a sentence: the type dot, the short name of its title and a dot in the
 * status colour, on a plate the size of the sentence. The status word and the owner are in the
 * preview and the accessible name. The whole chip is one link to the object, in the same tab. While
 * the object loads the original link stays; an object that is gone, or in another workspace, reads
 * "Deleted object".
 */
export function ObjectReferenceChip({
	workspaceId,
	objectId,
	fallback,
	cardFollows = true,
}: {
	workspaceId: string
	objectId: string
	fallback: ReactNode
	/** A draft's approval card is drawn under its sentence. Without one the draft is a chip too. */
	cardFollows?: boolean
}) {
	const object = useLinkedObject(workspaceId, objectId)
	const driver = useDriver(workspaceId, object)
	const typeLabel = useObjectTypeLabel()
	const sheet: ChipSheetContent = {
		card: <ObjectReferenceCard workspaceId={workspaceId} objectId={objectId} sheet />,
		openLink: <Link to="/$workspaceId/objects/$objectId" params={{ workspaceId, objectId }} />,
		path: `/${workspaceId}/objects/${objectId}`,
	}

	// A draft keeps its plain link while its approval card sits under the text. A draft with no
	// card (linked again, or past the card cap) is a chip, so the link that needs a yes is seen.
	if (object === null) {
		return <UnavailableChip kind="object" />
	}
	// While the object loads the original link stays and still previews (the card shows its
	// skeleton); a draft whose card follows has no preview.
	if (object === undefined || (cardFollows && showsObjectCard(object, workspaceId))) {
		return (
			<ChipPreview
				card={(actions) => (
					<ObjectReferenceCard
						workspaceId={workspaceId}
						objectId={objectId}
						preview
						actions={actions}
					/>
				)}
				sheet={sheet}
				enabled={object === undefined}
			>
				{object === undefined ? loadingChip(fallback) : fallback}
			</ChipPreview>
		)
	}

	const title = object.title?.trim() || 'Untitled'
	const owner = driver.state === 'known' ? driver.actor : null
	const status = statusLabel(object.status)
	const name = `${typeLabel(object.type)}, ${status.charAt(0).toUpperCase()}${status.slice(1)}: ${title}${
		owner ? `, ${owner.name}` : ''
	}`
	const TypeIcon = typeIconOf(object.type)
	return (
		<ChipPreview
			card={(actions) => (
				<ObjectReferenceCard
					workspaceId={workspaceId}
					objectId={objectId}
					preview
					actions={actions}
				/>
			)}
			sheet={sheet}
			enabled
		>
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: object.id }}
				aria-label={name}
				className={CHIP}
			>
				<ChipText
					lead={
						<TypeIcon
							size="0.85em"
							aria-hidden
							className={cn('mr-[0.4em] inline-block align-middle', typeIconColor(object.type))}
						/>
					}
					text={cutLabel(shortName(title))}
					trail={
						object.status ? (
							<span
								aria-hidden="true"
								className={cn(
									CHIP_DOT,
									'ml-[0.4em] size-[0.4em]',
									(statusColors[object.status] ?? defaultStatusColor).text,
								)}
							/>
						) : null
					}
				/>
			</Link>
		</ChipPreview>
	)
}

/**
 * A link to a GitHub pull request or issue: its icon, "{repo} #{n}" and a small arrow, because it
 * leaves the app. Built from the address alone, so there is no card, no preview and no fetch. It
 * opens GitHub in a new tab, wherever it stands (in a sentence or alone on a line).
 */
export function GithubReferenceChip({ target, href }: { target: GithubTarget; href: string }) {
	const Icon = target.type === 'pull' ? GitPullRequest : CircleDot
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={githubChipName(target)}
			className={CHIP}
		>
			<ChipText
				lead={<Icon size="0.85em" aria-hidden className={CHIP_ICON} />}
				text={githubChipText(target)}
				trail={
					<ArrowUpRight
						size="0.85em"
						aria-hidden
						className="ml-[0.2em] inline-block align-middle text-muted-foreground"
					/>
				}
			/>
		</a>
	)
}

// The page each settings section opens: the same routes as the settings menu.
const SETTINGS_ROUTES = {
	'': '/$workspaceId/settings',
	objects: '/$workspaceId/settings/objects',
	members: '/$workspaceId/settings/members',
	integrations: '/$workspaceId/settings/integrations',
	extensions: '/$workspaceId/settings/extensions',
	skills: '/$workspaceId/settings/skills',
	mcp: '/$workspaceId/settings/mcp',
	billing: '/$workspaceId/settings/billing',
	keychain: '/$workspaceId/settings/keychain',
	keys: '/$workspaceId/settings/keys',
} as const satisfies Record<SettingsTarget['path'], string>

/**
 * A link to a settings page: a gear and "Settings: {section}". Built from the address alone, so
 * there is no card, no preview and no fetch, wherever it stands (in a sentence or alone on a
 * line). One link to the page, in the same tab.
 */
export function SettingsReferenceChip({
	workspaceId,
	target,
}: {
	workspaceId: string
	target: SettingsTarget
}) {
	const text = settingsChipText(target)
	return (
		<Link
			to={SETTINGS_ROUTES[target.path]}
			params={{ workspaceId }}
			aria-label={text}
			className={CHIP}
		>
			<ChipText
				lead={<SettingsIcon size="0.85em" aria-hidden className={CHIP_ICON} />}
				text={text}
			/>
		</Link>
	)
}

const CARD_SHELL =
	'not-prose @container my-2 flex w-full max-w-[460px] flex-col rounded-xl border bg-card'
// The same card as a hover preview: no outer margin, a fixed width, lifted off the page.
const PREVIEW_SHELL =
	'not-prose @container flex w-[min(380px,78vw)] max-w-full flex-col rounded-xl border bg-card shadow-md'
// The same card as the face of the phone sheet: the width of the sheet, no margin, no shadow.
const SHEET_SHELL = 'not-prose @container flex w-full flex-col rounded-xl border bg-card'

/** A loading bar made of spans, so a preview inside a paragraph stays valid HTML. */
function Bar({ className }: { className: string }) {
	return (
		<span aria-hidden="true" className={cn('block animate-pulse rounded bg-muted', className)} />
	)
}

// An open card is the link and, beside it, a fold button: a button inside a link is invalid HTML, so
// the shell (border, background, width) is this wrapper and the link inside it has none.
const OPEN_CARD_LINK = 'group flex flex-col rounded-xl p-3 no-underline focus-visible:outline-none'
// Room at the end of the first row for the fold button, which sits over it.
const FOLD_ROOM = 'mr-7'
const FOLD_BUTTON =
	'absolute top-2.5 right-3 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors duration-180 ease-standard hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * A card on its own line that can be folded to one row: its type (or kind), title and state. The
 * state is in this page only and every card starts open. No motion, so the thread does not jump.
 * The fold button is a second tab stop after the card's link; focus stays on it as it swaps.
 */
function FoldableCard({
	title,
	head,
	state,
	children,
}: {
	title: string
	/** The type badge or kind tag. */
	head: ReactNode
	/** The status badge or state. */
	state: ReactNode
	/** The card's link, drawn without a shell of its own. */
	children: ReactNode
}) {
	const [folded, setFolded] = useState(false)
	const root = useRef<HTMLSpanElement>(null)
	const toggled = useRef(false)

	// biome-ignore lint/correctness/useExhaustiveDependencies: folded is the trigger (the button swaps), its value is not read inside
	useEffect(() => {
		if (!toggled.current) return
		toggled.current = false
		root.current?.querySelector('button')?.focus()
	}, [folded])

	const toggle = () => {
		toggled.current = true
		setFolded((value) => !value)
	}

	return (
		<span
			ref={root}
			data-linked-card=""
			className={cn(
				CARD_SHELL,
				'relative border-border transition-colors duration-180 ease-standard hover:border-border-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring',
				folded && 'h-10',
			)}
		>
			{folded ? (
				<button
					type="button"
					aria-expanded={false}
					aria-label={`Unfold card: ${title}`}
					onClick={toggle}
					className="flex size-full items-center gap-1.5 rounded-xl px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="shrink-0">{head}</span>
					<span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
						{title}
					</span>
					<span className="shrink-0">{state}</span>
					<ChevronDown size={14} aria-hidden className="shrink-0 text-muted-foreground" />
				</button>
			) : (
				<>
					{children}
					<button
						type="button"
						aria-expanded
						aria-label="Fold card"
						onClick={toggle}
						className={FOLD_BUTTON}
					>
						<ChevronUp size={14} aria-hidden />
					</button>
				</>
			)}
		</span>
	)
}

/**
 * What a card is drawn in: the link to its target (the whole card), or in the hover preview and the
 * phone sheet a plain box, since their own Open buttons are the link. `link` is that link without
 * children.
 */
function CardFace({
	link,
	shell,
	preview,
	sheet,
	children,
}: {
	link: ReactElement<{ className?: string; children?: ReactNode }>
	shell: string
	preview: boolean
	sheet: boolean
	children: ReactNode
}) {
	// The hover preview and the phone sheet are plain boxes: their Open and Copy link are buttons.
	if (preview || sheet) return <span className={cn(shell, 'border-border p-3')}>{children}</span>
	return cloneElement(link, { className: OPEN_CARD_LINK }, children)
}

/** The workspace's own name for a type, on the type's own colours. */
function TypeTag({ type, label }: { type: string; label: string }) {
	const colors = typeColors[type] ?? defaultTypeColor
	return (
		<span
			className={cn(
				'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
				colors.bg,
				colors.text,
			)}
		>
			{label}
		</span>
	)
}

/**
 * A link that stands alone on its line, drawn as a card where it stands: what the object is,
 * where it stands, the fields it has filled in, who has it and when it last changed. Every field is
 * on the object record. The whole card is one link to the object.
 */
export function ObjectReferenceCard({
	workspaceId,
	objectId,
	preview = false,
	sheet = false,
	actions,
}: {
	workspaceId: string
	objectId: string
	/** Drawn as the hover preview of a chip: same card, not a link, not counted as a card. */
	preview?: boolean
	/** Drawn as the face of the phone sheet of a chip: same card, not a link, not counted as a card. */
	sheet?: boolean
	/** The preview's Copy link and Open, at the right end of the footer. */
	actions?: ReactNode
}) {
	const object = useLinkedObject(workspaceId, objectId)
	const driver = useDriver(workspaceId, object)
	const typeLabel = useObjectTypeLabel()
	const { workspace } = useWorkspace()
	const shell = sheet ? SHEET_SHELL : preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview || sheet ? undefined : ''

	if (object === undefined) {
		return (
			<span
				data-linked-card={marker}
				aria-busy="true"
				className={cn(shell, 'gap-2 border-border p-3')}
			>
				<Bar className="h-4 w-1/3" />
				<Bar className="h-4 w-4/5" />
				<Bar className="h-3 w-1/2" />
			</span>
		)
	}
	if (object === null) {
		return <UnavailableCard shell={shell} marker={marker} kind="object" />
	}

	const title = object.title?.trim() || 'Untitled'
	const snippet = plainSnippet(object.content)
	const fieldDefs = (
		workspace.settings as
			| { field_definitions?: Record<string, { name: string; type?: string }[]> }
			| undefined
	)?.field_definitions?.[object.type]
	const facts = pickFacts(fieldDefs, object.metadata)
	const TypeIcon = typeIconOf(object.type)
	const working = object.active_session_state === 'running'
	const head = <TypeTag type={object.type} label={typeLabel(object.type)} />
	const state = <StatusBadge status={object.status} />
	const link = (
		<CardFace
			shell={shell}
			preview={preview}
			sheet={sheet}
			link={
				<Link to="/$workspaceId/objects/$objectId" params={{ workspaceId, objectId: object.id }} />
			}
		>
			<LinkedCardFace
				icon={<TypeIcon size={14} aria-hidden />}
				tile={typeTileClass(object.type)}
				eyebrow={typeLabel(object.type)}
				state={state}
				trailing={preview || sheet ? null : <OpenArrow />}
				title={title}
				summary={snippet}
				facts={facts}
				actions={actions}
				footer={
					<>
						<span className="inline-flex min-w-0 items-center gap-1.5">
							{driver.state === 'known' ? (
								<>
									<ActorAvatar
										id={driver.actor.id}
										name={driver.actor.name}
										type={driver.actor.type}
										size="sm"
										className={AVATAR}
									/>
									<span className="truncate">{driver.actor.name}</span>
								</>
							) : driver.state === 'none' ? (
								'Unassigned'
							) : driver.state === 'gone' ? (
								'Unknown'
							) : (
								<Bar className="h-3 w-16" />
							)}
						</span>
						{object.updatedAt ? (
							<span>
								Updated <RelativeTime date={object.updatedAt} />
							</span>
						) : null}
						{working ? (
							<span className="ml-auto inline-flex items-center gap-1 font-semibold text-brand">
								<span
									aria-hidden="true"
									className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse"
								/>
								Working now
							</span>
						) : null}
					</>
				}
			/>
		</CardFace>
	)
	return preview || sheet ? (
		link
	) : (
		<FoldableCard title={title} head={head} state={state}>
			{link}
		</FoldableCard>
	)
}

/** The loop in this workspace's list, or null while it loads (`undefined`) or when it is not in it (`null`). */
function useLinkedLoop(workspaceId: string, loopId: string): LoopSummary | null | undefined {
	const { data, isLoading } = useLoop(loopId, workspaceId)
	return isLoading ? undefined : (data ?? null)
}

/** The trigger in this workspace's list, or null while it loads (`undefined`) or when it is not in it (`null`). */
function useLinkedTrigger(
	workspaceId: string,
	triggerId: string,
): TriggerResponse | null | undefined {
	const { data, isLoading } = useTrigger(triggerId, workspaceId)
	return isLoading ? undefined : (data ?? null)
}

const KIND_TAG =
	'inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground'
const AVATAR = 'size-4 shrink-0 text-[8px]'
// Secondary tile and badge colours for a kind with no type colour of its own.
const KIND_TILE = 'bg-secondary text-secondary-foreground'

/** An agent as an avatar and a name, for a card footer. */
function AgentLabel({ agent }: { agent: { id: string; name: string; type: string } }) {
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<ActorAvatar id={agent.id} name={agent.name} type={agent.type} size="sm" className={AVATAR} />
			<span className="truncate">{agent.name}</span>
		</span>
	)
}

/** The open arrow at the end of a card's first row, with room left for the fold button. */
function OpenArrow() {
	return (
		<span
			className={cn(
				'inline-flex shrink-0 items-center text-muted-foreground transition-colors duration-180 ease-standard group-hover:text-foreground',
				FOLD_ROOM,
			)}
		>
			<span className="sr-only">Open</span>
			<ArrowUpRight size={14} aria-hidden />
		</span>
	)
}

/** The loading card of a loop or trigger. */
function LinkedCardSkeleton({ shell, marker }: { shell: string; marker: string | undefined }) {
	return (
		<span
			data-linked-card={marker}
			aria-busy="true"
			className={cn(shell, 'gap-2 border-border p-3')}
		>
			<Bar className="h-4 w-1/3" />
			<Bar className="h-4 w-4/5" />
			<Bar className="h-3 w-1/2" />
		</span>
	)
}

/** The loop's agents that the workspace's actor list knows, in the loop's order. */
function useLoopAgents(workspaceId: string, loop: LoopSummary | null | undefined) {
	const { data: actors } = useActors(workspaceId, { enabled: true })
	return (loop?.agentIds ?? []).flatMap((id) => {
		const actor = actors?.find((a) => a.id === id)
		return actor ? [actor] : []
	})
}

/**
 * The "when it fires" line of a trigger, as the Loops page row shows it, except that a schedule
 * the app cannot put into words (`describeTrigger` then echoes the raw cron expression) reads
 * "Runs on a schedule": the raw expression is never shown here.
 */
function whenItFires(trigger: TriggerResponse): string {
	const text = describeTrigger(trigger)
	const expression = trigger.type === 'cron' ? String(trigger.config?.expression ?? '') : ''
	return expression && text.includes(expression) ? 'Runs on a schedule' : text
}

/** The agent a trigger wakes: `loading` until the actor list is in, `gone` when it is not on it. */
function useTriggerAgent(workspaceId: string, trigger: TriggerResponse | null | undefined) {
	const { data: actors } = useActors(workspaceId, { enabled: true })
	if (!trigger) return { state: 'loading' as const }
	const actor = actors?.find((a) => a.id === trigger.targetActorId)
	if (actor) return { state: 'known' as const, actor }
	return { state: actors ? ('gone' as const) : ('loading' as const) }
}

/**
 * A link to a loop inside a sentence: refresh icon and name, on the same plate as the object chip.
 * The state word and the agents are in the preview and the accessible name. The whole chip is one
 * link to the loop, in the same tab. While the loops load the original link stays; a loop that is
 * not in this workspace's list reads "Deleted loop".
 */
export function LoopReferenceChip({
	workspaceId,
	loopId,
	fallback,
}: {
	workspaceId: string
	loopId: string
	fallback: ReactNode
}) {
	const loop = useLinkedLoop(workspaceId, loopId)
	const card = (actions: ReactNode) => (
		<LoopReferenceCard workspaceId={workspaceId} loopId={loopId} preview actions={actions} />
	)
	const sheet: ChipSheetContent = {
		card: <LoopReferenceCard workspaceId={workspaceId} loopId={loopId} sheet />,
		openLink: <Link to="/$workspaceId/loops/$loopId" params={{ workspaceId, loopId }} />,
		path: `/${workspaceId}/loops/${loopId}`,
	}

	if (loop === null) return <UnavailableChip kind="loop" />
	if (loop === undefined) {
		return (
			<ChipPreview card={card} sheet={sheet} enabled>
				{loadingChip(fallback, false)}
			</ChipPreview>
		)
	}

	const name = loop.name?.trim() || 'Untitled loop'
	const state = LOOP_PILL_STYLES[loop.pill].label.toLowerCase()
	return (
		<ChipPreview card={card} sheet={sheet} enabled>
			<Link
				to="/$workspaceId/loops/$loopId"
				params={{ workspaceId, loopId: loop.id }}
				aria-label={`Loop, ${state}: ${name}`}
				className={CHIP}
			>
				<ChipText
					lead={<RefreshCw size="0.95em" aria-hidden className={CHIP_ICON} />}
					text={name}
				/>
			</Link>
		</ChipPreview>
	)
}

/**
 * A link to a loop that stands alone on its line, drawn as a card where it stands: its name and
 * description, where it stands on the autonomy ladder, who works it, and when it last changed.
 * Every field is on the loops list the Loops page reads. The whole card is one link to the loop.
 */
export function LoopReferenceCard({
	workspaceId,
	loopId,
	preview = false,
	sheet = false,
	actions,
}: {
	workspaceId: string
	loopId: string
	/** Drawn as the hover preview of a chip: same card, not a link, not counted as a card. */
	preview?: boolean
	/** Drawn as the face of the phone sheet of a chip: same card, not a link, not counted as a card. */
	sheet?: boolean
	/** The preview's Copy link and Open, at the right end of the footer. */
	actions?: ReactNode
}) {
	const loop = useLinkedLoop(workspaceId, loopId)
	const agents = useLoopAgents(workspaceId, loop)
	const shell = sheet ? SHEET_SHELL : preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview || sheet ? undefined : ''

	if (loop === undefined) return <LinkedCardSkeleton shell={shell} marker={marker} />
	if (loop === null) {
		return <UnavailableCard shell={shell} marker={marker} kind="loop" />
	}

	const pill = LOOP_PILL_STYLES[loop.pill]
	const snippet = plainSnippet(loop.content)
	const activity = loopActivityLine(loop)
	const agentNames = agents.map((agent) => agent.name).join(', ')
	const facts: CardFact[] = [
		...(agentNames ? [{ label: 'Agents', value: agentNames }] : []),
		...(activity ? [{ label: 'Activity', value: activity }] : []),
	]
	const name = loop.name?.trim() || 'Untitled loop'
	const head = (
		<span className={KIND_TAG}>
			<RefreshCw size={11} aria-hidden />
			Loop
		</span>
	)
	const state = (
		<span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', pill.text)}>
			<span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', pill.dot)} />
			{pill.label}
		</span>
	)
	const link = (
		<CardFace
			shell={shell}
			preview={preview}
			sheet={sheet}
			link={<Link to="/$workspaceId/loops/$loopId" params={{ workspaceId, loopId: loop.id }} />}
		>
			<LinkedCardFace
				icon={<RefreshCw size={14} aria-hidden />}
				tile={KIND_TILE}
				eyebrow="Loop"
				state={state}
				trailing={preview || sheet ? null : <OpenArrow />}
				title={name}
				summary={snippet}
				facts={facts}
				actions={actions}
				footer={
					<>
						{agents[0] ? <AgentLabel agent={agents[0]} /> : null}
						{loop.updatedAt ? (
							<span>
								Updated <RelativeTime date={loop.updatedAt} />
							</span>
						) : null}
					</>
				}
			/>
		</CardFace>
	)
	return preview || sheet ? (
		link
	) : (
		<FoldableCard title={name} head={head} state={state}>
			{link}
		</FoldableCard>
	)
}

/**
 * A link to a trigger inside a sentence: the icon of its kind and name, on the same plate as the
 * object chip. On or Off and the agent it wakes are in the preview and the accessible name. The
 * whole chip is one link to the trigger, in the same tab. While the triggers load the original link
 * stays; one not in this workspace's list reads "Deleted trigger".
 */
export function TriggerReferenceChip({
	workspaceId,
	triggerId,
	fallback,
}: {
	workspaceId: string
	triggerId: string
	fallback: ReactNode
}) {
	const trigger = useLinkedTrigger(workspaceId, triggerId)
	const card = (actions: ReactNode) => (
		<TriggerReferenceCard
			workspaceId={workspaceId}
			triggerId={triggerId}
			preview
			actions={actions}
		/>
	)
	const sheet: ChipSheetContent = {
		card: <TriggerReferenceCard workspaceId={workspaceId} triggerId={triggerId} sheet />,
		openLink: <Link to="/$workspaceId/triggers/$triggerId" params={{ workspaceId, triggerId }} />,
		path: `/${workspaceId}/triggers/${triggerId}`,
	}

	if (trigger === null) return <UnavailableChip kind="trigger" />
	if (trigger === undefined) {
		return (
			<ChipPreview card={card} sheet={sheet} enabled>
				{loadingChip(fallback, false)}
			</ChipPreview>
		)
	}

	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap
	const state = trigger.enabled ? 'on' : 'off'
	return (
		<ChipPreview card={card} sheet={sheet} enabled>
			<Link
				to="/$workspaceId/triggers/$triggerId"
				params={{ workspaceId, triggerId: trigger.id }}
				aria-label={`Trigger, ${state}: ${trigger.name}`}
				className={CHIP}
			>
				<ChipText
					lead={<Icon size="0.95em" aria-hidden className={CHIP_ICON} />}
					text={trigger.name}
				/>
			</Link>
		</ChipPreview>
	)
}

/**
 * A link to a trigger that stands alone on its line, drawn as a card where it stands: its name,
 * when it fires, whether it is on, and the agent it wakes. The instruction it sends and its raw
 * schedule are never shown. The whole card is one link to the trigger.
 */
export function TriggerReferenceCard({
	workspaceId,
	triggerId,
	preview = false,
	sheet = false,
	actions,
}: {
	workspaceId: string
	triggerId: string
	/** Drawn as the hover preview of a chip: same card, not a link, not counted as a card. */
	preview?: boolean
	/** Drawn as the face of the phone sheet of a chip: same card, not a link, not counted as a card. */
	sheet?: boolean
	/** The preview's Copy link and Open, at the right end of the footer. */
	actions?: ReactNode
}) {
	const trigger = useLinkedTrigger(workspaceId, triggerId)
	const agent = useTriggerAgent(workspaceId, trigger)
	const shell = sheet ? SHEET_SHELL : preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview || sheet ? undefined : ''

	if (trigger === undefined) return <LinkedCardSkeleton shell={shell} marker={marker} />
	if (trigger === null) {
		return <UnavailableCard shell={shell} marker={marker} kind="trigger" />
	}

	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap
	const facts: CardFact[] =
		agent.state === 'loading'
			? []
			: [{ label: 'Wakes', value: agent.state === 'known' ? agent.actor.name : 'Unknown' }]
	const head = (
		<span className={KIND_TAG}>
			<Icon size={11} aria-hidden />
			Trigger
		</span>
	)
	const state = (
		<span
			className={cn(
				'text-[11px] font-semibold',
				trigger.enabled ? 'text-success' : 'text-muted-foreground',
			)}
		>
			{trigger.enabled ? 'On' : 'Off'}
		</span>
	)
	const link = (
		<CardFace
			shell={shell}
			preview={preview}
			sheet={sheet}
			link={
				<Link
					to="/$workspaceId/triggers/$triggerId"
					params={{ workspaceId, triggerId: trigger.id }}
				/>
			}
		>
			<LinkedCardFace
				icon={<Icon size={14} aria-hidden />}
				tile={KIND_TILE}
				eyebrow="Trigger"
				state={state}
				trailing={preview || sheet ? null : <OpenArrow />}
				title={trigger.name}
				summary={whenItFires(trigger)}
				facts={facts}
				actions={actions}
				footer={
					agent.state === 'known' ? (
						<AgentLabel agent={agent.actor} />
					) : agent.state === 'gone' ? (
						<span>Unknown</span>
					) : (
						<Bar className="h-3 w-16" />
					)
				}
			/>
		</CardFace>
	)
	return preview || sheet ? (
		link
	) : (
		<FoldableCard title={trigger.name} head={head} state={state}>
			{link}
		</FoldableCard>
	)
}

/**
 * What the app knows of a linked agent, read from the workspace's actor list and the sessions list
 * the sidebar uses (the 100 newest), so a link costs no request of its own. `loading` until both
 * are in, `gone` when the actor is not on the list, `person` when the address points at a human
 * (that stays a plain link). A connected tool is a system actor: it is never working.
 */
function useLinkedAgent(workspaceId: string, agentId: string) {
	const { data: actors } = useActors(workspaceId, { enabled: true })
	const { data: sessions, isLoading } = useWorkspaceSessions(workspaceId)
	if (!actors || isLoading) return { state: 'loading' as const }
	const actor: ActorListItem | undefined = actors.find((a) => a.id === agentId)
	if (!actor) return { state: 'gone' as const }
	if (actor.type === 'human') return { state: 'person' as const }
	const own = (sessions ?? []).filter((s) => s.actorId === agentId)
	const newest = own.reduce<(typeof own)[number] | null>(
		(latest, s) =>
			!latest || new Date(s.createdAt ?? 0).getTime() > new Date(latest.createdAt ?? 0).getTime()
				? s
				: latest,
		null,
	)
	return {
		state: 'known' as const,
		actor,
		working: !actor.isSystem && own.some((s) => ACTIVE_STATUSES.has(s.status)),
		lastActive: newest ? (newest.updatedAt ?? newest.createdAt) : null,
	}
}

const agentName = (actor: ActorListItem) => actor.name?.trim() || 'Untitled agent'

/**
 * A link to an agent inside a sentence: bot icon and name, on the same plate as the object chip.
 * Working now or Idle is in the preview and the accessible name. The whole chip is one link to the
 * agent, in the same tab. While the lists load the original link stays; an agent that is not in
 * this workspace's list reads "Deleted agent", and an address that points at a person stays the
 * original link.
 */
export function AgentReferenceChip({
	workspaceId,
	agentId,
	fallback,
}: {
	workspaceId: string
	agentId: string
	fallback: ReactNode
}) {
	const agent = useLinkedAgent(workspaceId, agentId)
	const card = (actions: ReactNode) => (
		<AgentReferenceCard workspaceId={workspaceId} agentId={agentId} preview actions={actions} />
	)
	const sheet: ChipSheetContent = {
		card: <AgentReferenceCard workspaceId={workspaceId} agentId={agentId} sheet />,
		openLink: <Link to="/$workspaceId/agents/$agentId" params={{ workspaceId, agentId }} />,
		path: `/${workspaceId}/agents/${agentId}`,
	}

	if (agent.state === 'person') return <>{fallback}</>
	if (agent.state === 'gone') return <UnavailableChip kind="agent" />
	if (agent.state === 'loading') {
		return (
			<ChipPreview card={card} sheet={sheet} enabled>
				{loadingChip(fallback, false)}
			</ChipPreview>
		)
	}

	const name = agentName(agent.actor)
	return (
		<ChipPreview card={card} sheet={sheet} enabled>
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: agent.actor.id }}
				aria-label={`Agent, ${agent.working ? 'Working now' : 'Idle'}: ${name}`}
				className={CHIP}
			>
				<ChipText
					lead={<Bot size="0.95em" aria-hidden className={CHIP_ICON} />}
					text={cutLabel(shortName(name))}
				/>
			</Link>
		</ChipPreview>
	)
}

/**
 * A link to an agent that stands alone on its line, drawn as a card where it stands: its name and
 * description, whether it is working now, when it was last active and how many skills it has. Its
 * instructions, tools, keys and email are never shown. The whole card is one link to the agent.
 * It draws nothing for a person: the caller keeps the original link then (see `AgentCardOrLink`).
 */
export function AgentReferenceCard({
	workspaceId,
	agentId,
	preview = false,
	sheet = false,
	actions,
}: {
	workspaceId: string
	agentId: string
	/** Drawn as the hover preview of a chip: same card, not a link, not counted as a card. */
	preview?: boolean
	/** Drawn as the face of the phone sheet of a chip: same card, not a link, not counted as a card. */
	sheet?: boolean
	/** The preview's Copy link and Open, at the right end of the footer. */
	actions?: ReactNode
}) {
	const agent = useLinkedAgent(workspaceId, agentId)
	const shell = sheet ? SHEET_SHELL : preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview || sheet ? undefined : ''

	if (agent.state === 'person') return null
	if (agent.state === 'loading') return <LinkedCardSkeleton shell={shell} marker={marker} />
	if (agent.state === 'gone') {
		return <UnavailableCard shell={shell} marker={marker} kind="agent" />
	}

	const { actor, working, lastActive } = agent
	const name = agentName(actor)
	const skills = actor.skills?.length ?? 0
	const facts: CardFact[] = [
		...(lastActive ? [{ label: 'Last active', value: formatRelative(new Date(lastActive)) }] : []),
		...(skills > 0 ? [{ label: 'Skills', value: String(skills) }] : []),
	]
	const head = (
		<span className={KIND_TAG}>
			<Bot size={11} aria-hidden />
			Agent
		</span>
	)
	const state = working ? (
		<span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
			<span
				aria-hidden="true"
				className="size-1.5 shrink-0 rounded-full bg-brand motion-safe:animate-pulse"
			/>
			Working now
		</span>
	) : (
		<span className="text-[11px] font-semibold text-muted-foreground">Idle</span>
	)
	const link = (
		<CardFace
			shell={shell}
			preview={preview}
			sheet={sheet}
			link={
				<Link
					to="/$workspaceId/agents/$agentId"
					params={{ workspaceId, agentId: actor.id }}
					aria-label={`Agent, ${working ? 'Working now' : 'Idle'}: ${name}`}
				/>
			}
		>
			<LinkedCardFace
				icon={<Bot size={14} aria-hidden />}
				tile={KIND_TILE}
				eyebrow="Agent"
				state={state}
				trailing={preview || sheet ? null : <OpenArrow />}
				title={name}
				summary={actor.description?.trim() || undefined}
				facts={facts}
				actions={actions}
				footer={
					<>
						<span className="inline-flex min-w-0 items-center gap-1.5">
							<ActorAvatar
								id={actor.id}
								name={name}
								type={actor.type}
								size="sm"
								imageUrl={actor.avatar_url ?? undefined}
								className={AVATAR}
							/>
							<span className="truncate">{name}</span>
						</span>
						{lastActive ? (
							<span>
								Last active <RelativeTime date={lastActive} />
							</span>
						) : null}
					</>
				}
			/>
		</CardFace>
	)
	return preview || sheet ? (
		link
	) : (
		<FoldableCard title={name} head={head} state={state}>
			{link}
		</FoldableCard>
	)
}

/** What a link into another workspace points at, for the placeholder's words and its address. */
type OtherWorkspaceKind = 'object' | 'loop' | 'trigger' | 'agent' | 'chat'

const OTHER_WORKSPACE_KIND: Record<OtherWorkspaceKind, string> = {
	object: 'Object',
	loop: 'Loop',
	trigger: 'Trigger',
	agent: 'Agent',
	chat: 'Chat',
}

/**
 * "{Kind} in {workspace name}" when you belong to that workspace (the name is on the workspace
 * switcher's list), else "{Kind} in another workspace". Nothing is fetched from that workspace.
 */
export function useOtherWorkspaceLabel(kind: OtherWorkspaceKind, otherWorkspaceId: string): string {
	const { data: workspaces } = useWorkspaces()
	const name = workspaces
		?.find((w) => w.id.toLowerCase() === otherWorkspaceId.toLowerCase())
		?.name?.trim()
	return `${OTHER_WORKSPACE_KIND[kind]} in ${name || 'another workspace'}`
}

/** The link to the target in the other workspace, without children; the placeholders give it their look. */
export function OtherWorkspaceLink({
	kind,
	otherWorkspaceId,
	id,
	label,
	newTab = false,
	card = false,
	className,
	children,
}: {
	kind: OtherWorkspaceKind
	otherWorkspaceId: string
	id: string
	label: string
	newTab?: boolean
	/** Drawn as a card on its own line: marked so the three-card cap and the list bullet see it. */
	card?: boolean
	className: string
	children: ReactNode
}) {
	const props = {
		'aria-label': label,
		className,
		...(card ? { 'data-linked-card': '' } : {}),
		...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
	}
	switch (kind) {
		case 'loop':
			return (
				<Link
					to="/$workspaceId/loops/$loopId"
					params={{ workspaceId: otherWorkspaceId, loopId: id }}
					{...props}
				>
					{children}
				</Link>
			)
		case 'trigger':
			return (
				<Link
					to="/$workspaceId/triggers/$triggerId"
					params={{ workspaceId: otherWorkspaceId, triggerId: id }}
					{...props}
				>
					{children}
				</Link>
			)
		case 'agent':
			return (
				<Link
					to="/$workspaceId/agents/$agentId"
					params={{ workspaceId: otherWorkspaceId, agentId: id }}
					{...props}
				>
					{children}
				</Link>
			)
		case 'chat':
			return (
				<Link
					to="/$workspaceId/chats/$conversationId"
					params={{ workspaceId: otherWorkspaceId, conversationId: id }}
					{...props}
				>
					{children}
				</Link>
			)
		default:
			return (
				<Link
					to="/$workspaceId/objects/$objectId"
					params={{ workspaceId: otherWorkspaceId, objectId: id }}
					{...props}
				>
					{children}
				</Link>
			)
	}
}

/**
 * A link into another workspace, inside a sentence: a globe and "{Kind} in {workspace name}" on a
 * dashed, italic plate. Nothing is looked up, so there is no preview and no sheet; the whole chip
 * is one link that opens the target, in the same tab.
 */
export function OtherWorkspaceChip({
	kind,
	otherWorkspaceId,
	id,
}: {
	kind: OtherWorkspaceKind
	otherWorkspaceId: string
	id: string
}) {
	const label = useOtherWorkspaceLabel(kind, otherWorkspaceId)
	return (
		<OtherWorkspaceLink
			kind={kind}
			otherWorkspaceId={otherWorkspaceId}
			id={id}
			label={label}
			className="not-prose rounded-md border border-dashed border-border px-[0.4em] italic text-muted-foreground no-underline box-decoration-clone transition-colors duration-180 ease-standard hover:border-border-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<ChipText
				lead={<Globe size="0.85em" aria-hidden className="mr-[0.4em] inline-block align-middle" />}
				text={label}
			/>
		</OtherWorkspaceLink>
	)
}

/**
 * A link to a chat inside a sentence: the message icon and the chat's title, on the same plate as
 * the other chips. Pinned or archived and the people are in the preview. The whole chip is one
 * link to the chat, in the same tab. While the chat loads the original link stays; a chat that
 * cannot be shown (deleted, or one you are not in) reads "Chat not available".
 */
export function ChatReferenceChip({
	workspaceId,
	chatId,
	fallback,
}: {
	workspaceId: string
	chatId: string
	fallback: ReactNode
}) {
	const chat = useLinkedChat(workspaceId, chatId)
	const card = (actions: ReactNode) => (
		<ChatReferenceCard workspaceId={workspaceId} chatId={chatId} preview actions={actions} />
	)
	const sheet: ChipSheetContent = {
		card: <ChatReferenceCard workspaceId={workspaceId} chatId={chatId} sheet />,
		openLink: (
			<Link
				to="/$workspaceId/chats/$conversationId"
				params={{ workspaceId, conversationId: chatId }}
			/>
		),
		path: `/${workspaceId}/chats/${chatId}`,
	}

	if (chat === null) return <UnavailableChip kind="chat" />
	if (chat === undefined) {
		return (
			<ChipPreview card={card} sheet={sheet} enabled>
				{loadingChip(fallback, false)}
			</ChipPreview>
		)
	}

	const title = chat.title.trim() || 'Untitled chat'
	return (
		<ChipPreview card={card} sheet={sheet} enabled>
			<Link
				to="/$workspaceId/chats/$conversationId"
				params={{ workspaceId, conversationId: chat.id }}
				aria-label={`Chat: ${title}`}
				className={CHIP}
			>
				<ChipText
					lead={
						<MessageCircle
							size="0.95em"
							aria-hidden
							className={cn('mr-[0.4em] inline-block align-middle', typeIconColor('conversation'))}
						/>
					}
					text={cutLabel(title)}
				/>
			</Link>
		</ChipPreview>
	)
}

/**
 * A link into another workspace that stands alone on its line: the same words on a dashed, italic
 * card with a globe. It counts toward the three cards of a message like any card, fetches nothing
 * and has no fold, preview or sheet. The whole card is one link that opens the target.
 */
export function OtherWorkspaceCard({
	kind,
	otherWorkspaceId,
	id,
}: {
	kind: OtherWorkspaceKind
	otherWorkspaceId: string
	id: string
}) {
	const label = useOtherWorkspaceLabel(kind, otherWorkspaceId)
	return (
		<OtherWorkspaceLink
			kind={kind}
			otherWorkspaceId={otherWorkspaceId}
			id={id}
			label={label}
			card
			className={cn(
				CARD_SHELL,
				'flex-row items-center gap-2 border-dashed border-border bg-surface-sunken p-3 text-[12.5px] italic text-muted-foreground no-underline transition-colors duration-180 ease-standard hover:border-border-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			)}
		>
			<Globe size={14} aria-hidden className="shrink-0" />
			{label}
		</OtherWorkspaceLink>
	)
}

/**
 * A link to a chat that stands alone on its line, drawn as a card where it stands: its title, the
 * last message and who wrote it, who is in it, and when it last moved. A chat read by id has no
 * last message, so the line and the author are left out. Unread counts are never shown. The whole
 * card is one link to the chat.
 */
export function ChatReferenceCard({
	workspaceId,
	chatId,
	preview = false,
	sheet = false,
	actions,
}: {
	workspaceId: string
	chatId: string
	/** Drawn as the hover preview of a chip: same card, not a link, not counted as a card. */
	preview?: boolean
	/** Drawn as the face of the phone sheet of a chip: same card, not a link, not counted as a card. */
	sheet?: boolean
	/** The preview's Copy link and Open, at the right end of the footer. */
	actions?: ReactNode
}) {
	const chat = useLinkedChat(workspaceId, chatId)
	const shell = sheet ? SHEET_SHELL : preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview || sheet ? undefined : ''

	if (chat === undefined) return <LinkedCardSkeleton shell={shell} marker={marker} />
	if (chat === null) {
		return <UnavailableCard shell={shell} marker={marker} kind="chat" />
	}

	const title = chat.title.trim() || 'Untitled chat'
	// You are named "You" in the summary, as the chat list does, and last in the People row.
	const selfId = getStoredActor()?.id
	const author = chat.lastMessage?.authorId
		? chat.lastMessage.authorId === selfId
			? 'You'
			: chat.lastMessage.authorName
		: null
	const summary = chatSummary(author, chat.lastMessage?.text)
	const others = chat.participants.filter((p) => p.actorId !== selfId)
	const me = chat.participants.filter((p) => p.actorId === selfId)
	const people = peopleLine([...others, ...me].map((p) => p.actorName))
	const facts: CardFact[] = people ? [{ label: 'People', value: people }] : []
	const lastAuthor = chat.participants.find((p) => p.actorId === chat.lastMessage?.authorId)
	const badge = chat.archived ? 'Archived' : chat.pinned ? 'Pinned' : null
	const head = (
		<span className={KIND_TAG}>
			<MessageCircle size={11} aria-hidden />
			Chat
		</span>
	)
	const state = badge ? (
		<span className="text-[11px] font-semibold text-muted-foreground">{badge}</span>
	) : null
	const link = (
		<CardFace
			shell={shell}
			preview={preview}
			sheet={sheet}
			link={
				<Link
					to="/$workspaceId/chats/$conversationId"
					params={{ workspaceId, conversationId: chat.id }}
				/>
			}
		>
			<LinkedCardFace
				icon={<MessageCircle size={14} aria-hidden />}
				tile={typeTileClass('conversation')}
				eyebrow="Chat"
				state={state}
				trailing={preview || sheet ? null : <OpenArrow />}
				title={title}
				summary={summary ?? undefined}
				facts={facts}
				actions={actions}
				footer={
					<>
						{lastAuthor ? (
							<AgentLabel
								agent={{
									id: lastAuthor.actorId,
									name: lastAuthor.actorName,
									type: lastAuthor.actorType,
								}}
							/>
						) : null}
						{chat.updatedAt ? (
							<span>
								Updated <RelativeTime date={chat.updatedAt} />
							</span>
						) : null}
					</>
				}
			/>
		</CardFace>
	)
	return preview || sheet ? (
		link
	) : (
		<FoldableCard title={title} head={head} state={state}>
			{link}
		</FoldableCard>
	)
}
