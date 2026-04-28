import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import { useObjects } from '@/hooks/use-objects'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { type Caption, type CaptionPart, humanizeEvents } from './event-humanizer'

const FEED_LIMIT = '50'

interface LiveFeedCaptionsProps {
	maxCaptions?: number
	className?: string
}

/**
 * Auto-scrolling humanized stream of events for the dashboard. The captions
 * are rendered in agent-voice, with adjacent micro-actions collapsed by the
 * pure `humanizeEvents` transform. Pause-on-hover is implemented with a
 * `paused` flag that suppresses the slow auto-scroll while the cursor is
 * inside the feed — the underlying data still updates via SSE invalidation.
 *
 * This is the live-story surface; the forensic log lives at `/activity`.
 */
export function LiveFeedCaptions({ maxCaptions = 30, className }: LiveFeedCaptionsProps) {
	const { workspaceId } = useWorkspace()
	const { data: events, isLoading } = useEvents(workspaceId, { limit: FEED_LIMIT })
	const { data: actors } = useActors(workspaceId)
	const { data: objects } = useObjects(workspaceId)
	const [paused, setPaused] = useState(false)

	const actorLookup = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return (id: string | null) => (id ? map.get(id) : undefined)
	}, [actors])

	const objectLookup = useMemo(() => {
		const map = new Map<string, ObjectResponse>()
		for (const obj of objects ?? []) map.set(obj.id, obj)
		return (id: string | null) => (id ? map.get(id) : undefined)
	}, [objects])

	const captions = useMemo(
		() => humanizeEvents(events ?? [], actorLookup, objectLookup).slice(0, maxCaptions),
		[events, actorLookup, objectLookup, maxCaptions],
	)

	const onMouseEnter = useCallback(() => setPaused(true), [])
	const onMouseLeave = useCallback(() => setPaused(false), [])

	if (isLoading) return <ListSkeleton rows={6} />
	if (!captions.length) {
		return (
			<EmptyState
				title="The team is at rest"
				description="Captions will appear here as agents work."
			/>
		)
	}

	return (
		<div
			className={cn(
				'flex h-full flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-bg-surface p-4',
				paused && 'pause-feed',
				className,
			)}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			aria-live="polite"
			aria-label="Live feed of agent activity"
		>
			{captions.map((caption) => (
				<CaptionRow key={caption.id} caption={caption} workspaceId={workspaceId} />
			))}
		</div>
	)
}

function CaptionRow({ caption, workspaceId }: { caption: Caption; workspaceId: string }) {
	return (
		<div
			className={cn(
				'flex items-start gap-3 animate-slide-in',
				caption.actorType === 'agent' && 'text-text',
				caption.isError && 'opacity-90',
			)}
		>
			<ActorAvatar name={caption.actorName} type={caption.actorType} size="md" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex flex-wrap items-baseline gap-1.5 text-base text-text leading-snug">
					<span className="font-medium text-text">{caption.actorName}</span>
					{caption.parts.map((part, idx) => (
						<CaptionPartView key={`${caption.id}-${idx}`} part={part} workspaceId={workspaceId} />
					))}
					{caption.isError && (
						<Badge variant="destructive" className="px-1 py-0 text-[10px]">
							error
						</Badge>
					)}
				</div>
				<RelativeTime date={caption.timestamp} className="text-text-secondary text-xs" />
			</div>
		</div>
	)
}

function CaptionPartView({ part, workspaceId }: { part: CaptionPart; workspaceId: string }) {
	if (part.kind === 'text') {
		return <span className="text-text-secondary">{part.text}</span>
	}
	if (part.kind === 'object') {
		return (
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: part.objectId }}
				className="font-medium text-text hover:underline"
			>
				{part.title}
			</Link>
		)
	}
	return (
		<Badge variant="secondary" className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
			{part.label.replace(/_/g, ' ')}
		</Badge>
	)
}
