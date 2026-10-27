import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useActors } from '@/hooks/use-actors'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useObject } from '@/hooks/use-objects'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { defaultTypeColor, statusLabel, typeColors } from '@/lib/constants'
import { plainSnippet, showsObjectCard } from '@/lib/linked-objects'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

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
 * Opens the object card under its child while the pointer is over it or focus is inside it. The
 * card is the one the chip stands for, read from the same cache entry, so nothing is fetched
 * here; while that entry loads the card shows its skeleton. The preview is for the eye only:
 * hidden from the accessibility tree and not a tab stop, since the chip is already the link and
 * its name carries the same facts. Escape closes it.
 */
function ChipPreview({
	workspaceId,
	objectId,
	enabled,
	children,
}: {
	workspaceId: string
	objectId: string
	enabled: boolean
	children: ReactNode
}) {
	const capable = usePreviewCapable()
	const [open, setOpen] = useState(false)
	const shown = open && enabled && capable
	const root = useRef<HTMLSpanElement>(null)
	const [alignEnd, setAlignEnd] = useState(false)

	useLayoutEffect(() => {
		if (shown && root.current) {
			setAlignEnd(
				previewOverflows(root.current.getBoundingClientRect(), document.documentElement.clientWidth),
			)
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
			className="relative inline-block max-w-full align-middle"
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
					className={cn(
						'absolute top-full z-50 block pt-1 duration-180',
						alignEnd ? 'right-0' : 'left-0',
						'ease-standard animate-in fade-in-0 slide-in-from-bottom-0.5',
					)}
				>
					<ObjectReferenceCard workspaceId={workspaceId} objectId={objectId} preview />
				</span>
			) : null}
		</span>
	)
}

/**
 * A link to an object inside a sentence: type dot, title, status word and the owner's avatar. The
 * whole chip is one link to the object, in the same tab. While the object loads the original link
 * stays; an object that is gone, or in another workspace, reads "Deleted object".
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
		return (
			<span className="inline-flex items-center rounded-[9px] border border-dashed border-border px-2 py-0.5 align-baseline text-[11.5px] italic text-muted-foreground">
				Deleted object
			</span>
		)
	}
	// While the object loads the original link stays and still previews (the card shows its
	// skeleton); a draft has no preview.
	if (object === undefined || showsObjectCard(object, workspaceId)) {
		return (
			<ChipPreview workspaceId={workspaceId} objectId={objectId} enabled={object === undefined}>
				{fallback}
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
		<ChipPreview workspaceId={workspaceId} objectId={objectId} enabled>
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: object.id }}
				aria-label={name}
				className={cn(
					'not-prose inline-flex max-w-full items-center gap-[7px] rounded-[9px] border border-border bg-card py-0.5 pr-2 pl-2 align-middle text-[11.5px] no-underline',
					HOVER,
				)}
			>
				<TypeBadge type={object.type} variant="dot" />
				<span className="min-w-0 max-w-[16rem] truncate font-semibold text-foreground">
					{title}
				</span>
				<StatusBadge
					status={object.status}
					variant="word"
					className="text-[10.5px] font-semibold"
				/>
				{owner ? (
					<ActorAvatar
						id={owner.id}
						name={owner.name}
						type={owner.type}
						size="sm"
						className="size-4 shrink-0 text-[8px]"
					/>
				) : null}
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
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-linked-card={marker}
			tabIndex={preview ? -1 : undefined}
			className={cn(shell, 'group border-border p-3 no-underline', HOVER)}
		>
			<span className="flex items-center gap-1.5">
				{/* The workspace's own name for the type, on the type's own colours. */}
				<span
					className={cn(
						'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
						(typeColors[object.type] ?? defaultTypeColor).bg,
						(typeColors[object.type] ?? defaultTypeColor).text,
					)}
				>
					{typeLabel(object.type)}
				</span>
				<StatusBadge status={object.status} />
				{priority ? (
					<span className="font-mono text-[10.5px] font-semibold text-muted-foreground">
						{priority}
					</span>
				) : null}
				<span className="ml-auto inline-flex shrink-0 items-center text-muted-foreground transition-colors duration-180 ease-standard group-hover:text-foreground">
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
}
