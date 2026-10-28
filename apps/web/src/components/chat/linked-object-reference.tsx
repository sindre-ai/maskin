import { LOOP_PILL_STYLES } from '@/components/loops/loop-pill'
import { loopActivityLine } from '@/components/loops/loop-row'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { TRIGGER_TYPE_ICON, describeTrigger } from '@/components/triggers/trigger-row'
import { useActors } from '@/hooks/use-actors'
import { useLoop } from '@/hooks/use-loops'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject } from '@/hooks/use-objects'
import { useTrigger } from '@/hooks/use-triggers'
import type { LoopSummary, ObjectResponse, TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	defaultStatusColor,
	defaultTypeColor,
	statusColors,
	statusLabel,
	typeColors,
} from '@/lib/constants'
import { cutLabel, plainSnippet, shortName, showsObjectCard } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, ChevronDown, ChevronUp, RefreshCw, Zap } from 'lucide-react'
import {
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

const HOVER =
	'transition-colors duration-180 ease-standard hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

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

function priorityOf(object: ObjectResponse): string | null {
	const priority = (object.metadata as Record<string, unknown> | null)?.priority
	return typeof priority === 'string' || typeof priority === 'number'
		? String(priority).trim() || null
		: null
}

const PREVIEW_WIDTH = 380
const PREVIEW_EDGE = 8

/** True when a preview anchored to the chip's left edge would run off the right of the screen. */
function previewOverflows(chip: DOMRect, viewportWidth: number): boolean {
	const width = Math.min(PREVIEW_WIDTH, viewportWidth * 0.78)
	return chip.left + width > viewportWidth - PREVIEW_EDGE
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

/**
 * Opens the card under its child while the pointer is over it or focus is inside it. The chip
 * wraps with the sentence, so this wrapper is inline too: the card opens under the chip's last
 * line, at the left edge of the chip's bounding box (the right edge when that would run off the
 * screen). The
 * card is the one the chip stands for, read from the same cache entry, so nothing is fetched
 * here; while that entry loads the card shows its skeleton. The preview is for the eye only:
 * hidden from the accessibility tree and not a tab stop, since the chip is already the link and
 * its name carries the same facts. Escape closes it.
 */
function ChipPreview({
	card,
	enabled,
	children,
}: {
	/** The card to open, drawn as a preview (see the cards' `preview` prop). */
	card: ReactNode
	enabled: boolean
	children: ReactNode
}) {
	const capable = usePreviewCapable()
	const [open, setOpen] = useState(false)
	const shown = open && enabled && capable
	const root = useRef<HTMLSpanElement>(null)
	// The card is placed against the first and last line piece of the chip; `shift` moves it to the
	// bounding box of all of them (nothing for a chip on one line).
	const [place, setPlace] = useState({ alignEnd: false, shift: 0 })

	useLayoutEffect(() => {
		if (shown && root.current) {
			const box = root.current.getBoundingClientRect()
			const pieces = root.current.getClientRects()
			const first = pieces[0]
			const last = pieces[pieces.length - 1]
			const alignEnd = previewOverflows(box, document.documentElement.clientWidth)
			setPlace({
				alignEnd,
				shift: first && last ? (alignEnd ? last.right - box.right : box.left - first.left) : 0,
			})
		}
	}, [shown])

	useEffect(() => {
		if (!shown) return
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false)
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [shown])

	return (
		<span
			ref={root}
			className="relative"
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
				<span
					aria-hidden="true"
					data-linked-preview=""
					style={place.alignEnd ? { right: place.shift } : { left: place.shift }}
					className="absolute top-full z-50 block pt-1 duration-180 ease-standard animate-in fade-in-0 slide-in-from-bottom-0.5"
				>
					{card}
				</span>
			) : null}
		</span>
	)
}

// The chip is text: the size and line height of the sentence it sits in, a tinted plate that wraps
// with it (box-decoration-clone draws the plate on every line piece) and no vertical padding.
const CHIP =
	'not-prose rounded-md bg-muted px-[0.4em] font-medium text-foreground no-underline box-decoration-clone transition-colors duration-180 ease-standard hover:bg-brand-subtle hover:text-brand-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const DELETED_CHIP =
	'rounded-md border border-dashed border-border px-[0.4em] italic text-muted-foreground'
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
}: {
	workspaceId: string
	objectId: string
	fallback: ReactNode
}) {
	const object = useLinkedObject(workspaceId, objectId)
	const driver = useDriver(workspaceId, object)
	const typeLabel = useObjectTypeLabel()

	// A draft keeps its plain link: its approval card sits under the text.
	if (object === null) {
		return <span className={DELETED_CHIP}>Deleted object</span>
	}
	// While the object loads the original link stays and still previews (the card shows its
	// skeleton); a draft has no preview.
	if (object === undefined || showsObjectCard(object, workspaceId)) {
		return (
			<ChipPreview
				card={<ObjectReferenceCard workspaceId={workspaceId} objectId={objectId} preview />}
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
	return (
		<ChipPreview
			card={<ObjectReferenceCard workspaceId={workspaceId} objectId={objectId} preview />}
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
						<TypeBadge
							type={object.type}
							variant="dot"
							className={cn(CHIP_DOT, 'mr-[0.4em] size-[0.5em]')}
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

const CARD_SHELL =
	'not-prose @container my-2 flex w-full max-w-[460px] flex-col rounded-xl border bg-card'
// The same card as a hover preview: no outer margin, a fixed width, lifted off the page.
const PREVIEW_SHELL =
	'not-prose @container flex w-[min(380px,78vw)] flex-col rounded-xl border bg-card shadow-md'

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
 * where it stands, who has it and when it last changed. Every field is on the object record. The
 * whole card is one link to the object.
 */
export function ObjectReferenceCard({
	workspaceId,
	objectId,
	preview = false,
}: {
	workspaceId: string
	objectId: string
	/** Drawn as the hover preview of a chip: same card, not a tab stop, not counted as a card. */
	preview?: boolean
}) {
	const object = useLinkedObject(workspaceId, objectId)
	const driver = useDriver(workspaceId, object)
	const typeLabel = useObjectTypeLabel()
	const shell = preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview ? undefined : ''

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
		return (
			<span
				data-linked-card={marker}
				className={cn(
					shell,
					'border-dashed border-border bg-surface-sunken p-3 text-[12.5px] italic text-muted-foreground',
				)}
			>
				Deleted object
			</span>
		)
	}

	const title = object.title?.trim() || 'Untitled'
	const snippet = plainSnippet(object.content)
	const priority = priorityOf(object)
	const working = object.active_session_state === 'running'
	const head = <TypeTag type={object.type} label={typeLabel(object.type)} />
	const state = <StatusBadge status={object.status} />
	const link = (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			tabIndex={preview ? -1 : undefined}
			className={
				preview ? cn(shell, 'group border-border p-3 no-underline', HOVER) : OPEN_CARD_LINK
			}
		>
			<span className="flex items-center gap-1.5">
				{head}
				{state}
				{priority ? (
					<span className="font-mono text-[10.5px] font-semibold text-muted-foreground">
						{priority}
					</span>
				) : null}
				<span
					className={cn(
						'ml-auto inline-flex shrink-0 items-center text-muted-foreground transition-colors duration-180 ease-standard group-hover:text-foreground',
						!preview && FOLD_ROOM,
					)}
				>
					<span className="sr-only">Open</span>
					<ArrowUpRight size={14} aria-hidden />
				</span>
			</span>
			<span className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
				{title}
			</span>
			{snippet ? (
				<span className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
					{snippet}
				</span>
			) : null}
			<span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[11px] text-muted-foreground">
				<span className="inline-flex min-w-0 items-center gap-1.5">
					{driver.state === 'known' ? (
						<>
							<ActorAvatar
								id={driver.actor.id}
								name={driver.actor.name}
								type={driver.actor.type}
								size="sm"
								className="size-4 shrink-0 text-[8px]"
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
			</span>
		</Link>
	)
	return preview ? (
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
const OPEN_ARROW =
	'ml-auto inline-flex shrink-0 items-center text-muted-foreground transition-colors duration-180 ease-standard group-hover:text-foreground'
const AVATAR = 'size-4 shrink-0 text-[8px]'

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

/** The card of a loop or trigger that is gone, in another workspace or not visible to you. */
function LinkedCardDeleted({
	shell,
	marker,
	label,
}: { shell: string; marker: string | undefined; label: string }) {
	return (
		<span
			data-linked-card={marker}
			className={cn(
				shell,
				'border-dashed border-border bg-surface-sunken p-3 text-[12.5px] italic text-muted-foreground',
			)}
		>
			{label}
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
	const card = <LoopReferenceCard workspaceId={workspaceId} loopId={loopId} preview />

	if (loop === null) return <span className={DELETED_CHIP}>Deleted loop</span>
	if (loop === undefined) {
		return (
			<ChipPreview card={card} enabled>
				{loadingChip(fallback, false)}
			</ChipPreview>
		)
	}

	const name = loop.name?.trim() || 'Untitled loop'
	const state = LOOP_PILL_STYLES[loop.pill].label.toLowerCase()
	return (
		<ChipPreview card={card} enabled>
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
}: {
	workspaceId: string
	loopId: string
	/** Drawn as the hover preview of a chip: same card, not a tab stop, not counted as a card. */
	preview?: boolean
}) {
	const loop = useLinkedLoop(workspaceId, loopId)
	const agents = useLoopAgents(workspaceId, loop)
	const shell = preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview ? undefined : ''

	if (loop === undefined) return <LinkedCardSkeleton shell={shell} marker={marker} />
	if (loop === null) {
		return <LinkedCardDeleted shell={shell} marker={marker} label="Deleted loop" />
	}

	const pill = LOOP_PILL_STYLES[loop.pill]
	const snippet = plainSnippet(loop.content)
	const activity = loopActivityLine(loop)
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
		<Link
			to="/$workspaceId/loops/$loopId"
			params={{ workspaceId, loopId: loop.id }}
			tabIndex={preview ? -1 : undefined}
			className={
				preview ? cn(shell, 'group border-border p-3 no-underline', HOVER) : OPEN_CARD_LINK
			}
		>
			<span className="flex items-center gap-1.5">
				{head}
				{state}
				<span className={cn(OPEN_ARROW, !preview && FOLD_ROOM)}>
					<span className="sr-only">Open</span>
					<ArrowUpRight size={14} aria-hidden />
				</span>
			</span>
			<span className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
				{name}
			</span>
			{snippet ? (
				<span className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
					{snippet}
				</span>
			) : null}
			<span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[11px] text-muted-foreground">
				{agents.length > 0 ? (
					<span className="inline-flex items-center">
						{agents.slice(0, 5).map((agent) => (
							<ActorAvatar
								key={agent.id}
								id={agent.id}
								name={agent.name}
								type={agent.type}
								size="sm"
								className={cn(AVATAR, '-ml-1.5 ring-2 ring-card first:ml-0')}
							/>
						))}
						{agents.length > 5 ? <span className="ml-1">+{agents.length - 5}</span> : null}
					</span>
				) : null}
				{activity ? <span>{activity}</span> : null}
				{loop.updatedAt ? (
					<span>
						Updated <RelativeTime date={loop.updatedAt} />
					</span>
				) : null}
			</span>
		</Link>
	)
	return preview ? (
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
	const card = <TriggerReferenceCard workspaceId={workspaceId} triggerId={triggerId} preview />

	if (trigger === null) return <span className={DELETED_CHIP}>Deleted trigger</span>
	if (trigger === undefined) {
		return (
			<ChipPreview card={card} enabled>
				{loadingChip(fallback, false)}
			</ChipPreview>
		)
	}

	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap
	const state = trigger.enabled ? 'on' : 'off'
	return (
		<ChipPreview card={card} enabled>
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
}: {
	workspaceId: string
	triggerId: string
	/** Drawn as the hover preview of a chip: same card, not a tab stop, not counted as a card. */
	preview?: boolean
}) {
	const trigger = useLinkedTrigger(workspaceId, triggerId)
	const agent = useTriggerAgent(workspaceId, trigger)
	const shell = preview ? PREVIEW_SHELL : CARD_SHELL
	const marker = preview ? undefined : ''

	if (trigger === undefined) return <LinkedCardSkeleton shell={shell} marker={marker} />
	if (trigger === null) {
		return <LinkedCardDeleted shell={shell} marker={marker} label="Deleted trigger" />
	}

	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap
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
		<Link
			to="/$workspaceId/triggers/$triggerId"
			params={{ workspaceId, triggerId: trigger.id }}
			tabIndex={preview ? -1 : undefined}
			className={
				preview ? cn(shell, 'group border-border p-3 no-underline', HOVER) : OPEN_CARD_LINK
			}
		>
			<span className="flex items-center gap-1.5">
				{head}
				{state}
				<span className={cn(OPEN_ARROW, !preview && FOLD_ROOM)}>
					<span className="sr-only">Open</span>
					<ArrowUpRight size={14} aria-hidden />
				</span>
			</span>
			<span className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
				{trigger.name}
			</span>
			<span className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
				{whenItFires(trigger)}
			</span>
			<span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[11px] text-muted-foreground">
				<span className="inline-flex min-w-0 items-center gap-1.5">
					{agent.state === 'known' ? (
						<>
							<ActorAvatar
								id={agent.actor.id}
								name={agent.actor.name}
								type={agent.actor.type}
								size="sm"
								className={AVATAR}
							/>
							<span className="truncate">{agent.actor.name}</span>
						</>
					) : agent.state === 'gone' ? (
						'Unknown'
					) : (
						<Bar className="h-3 w-16" />
					)}
				</span>
			</span>
		</Link>
	)
	return preview ? (
		link
	) : (
		<FoldableCard title={trigger.name} head={head} state={state}>
			{link}
		</FoldableCard>
	)
}
