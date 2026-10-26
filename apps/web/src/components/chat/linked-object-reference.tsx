import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Skeleton } from '@/components/shared/loading-skeleton'
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
import type { ReactNode } from 'react'

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
	if (object === undefined || showsObjectCard(object, workspaceId)) return <>{fallback}</>
	if (object === null) {
		return <span className="italic text-muted-foreground opacity-60">Deleted object</span>
	}

	const title = object.title?.trim() || 'Untitled'
	const owner = driver.state === 'known' ? driver.actor : null
	const status = statusLabel(object.status)
	const name = `${typeLabel(object.type)}, ${status.charAt(0).toUpperCase()}${status.slice(1)}: ${title}${
		owner ? `, ${owner.name}` : ''
	}`
	return (
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
			<span className="min-w-0 max-w-[16rem] truncate font-semibold text-foreground">{title}</span>
			<StatusBadge status={object.status} variant="word" className="text-[10.5px] font-semibold" />
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
	)
}

const CARD_SHELL =
	'not-prose @container my-2 flex w-full max-w-[460px] flex-col rounded-xl border bg-card'

/**
 * A link that stands alone on its line, drawn as a card where it stands: what the object is,
 * where it stands, who has it and when it last changed. Every field is on the object record. The
 * whole card is one link to the object.
 */
export function ObjectReferenceCard({
	workspaceId,
	objectId,
}: {
	workspaceId: string
	objectId: string
}) {
	const object = useLinkedObject(workspaceId, objectId)
	const driver = useDriver(workspaceId, object)
	const typeLabel = useObjectTypeLabel()

	if (object === undefined) {
		return (
			<div
				data-linked-card=""
				aria-busy="true"
				className={cn(CARD_SHELL, 'gap-2 border-border px-3 py-2.5')}
			>
				<Skeleton className="h-4 w-1/3" />
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="h-3 w-1/2" />
			</div>
		)
	}
	if (object === null) {
		return (
			<div
				data-linked-card=""
				className={cn(
					CARD_SHELL,
					'border-dashed border-border px-3 py-2.5 text-sm italic text-muted-foreground',
				)}
			>
				Deleted object
			</div>
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
			data-linked-card=""
			className={cn(CARD_SHELL, 'group gap-1.5 border-border px-3 py-2.5 no-underline', HOVER)}
		>
			<span className="flex items-center gap-2">
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
			<span className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
				{title}
			</span>
			{snippet ? (
				<span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{snippet}</span>
			) : null}
			<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
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
						<Skeleton className="h-3 w-16" />
					)}
				</span>
				{object.updatedAt ? (
					<span>
						Updated <RelativeTime date={object.updatedAt} />
					</span>
				) : null}
				{working ? (
					<span className="inline-flex items-center gap-1.5 font-medium text-foreground">
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
						/>
						Working now
					</span>
				) : null}
			</span>
		</Link>
	)
}
