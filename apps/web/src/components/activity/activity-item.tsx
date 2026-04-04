import { useActor } from '@/hooks/use-actors'
import type { ActorResponse, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNavigate } from '@tanstack/react-router'
import { Activity, CircleDot, Link2, Pencil, Play, RefreshCw, Trash2, Unlink } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'
import { Badge } from '../ui/badge'
import { formatEventDescription, isErrorEvent } from './format-event'

function getEventIcon(event: EventResponse) {
	const action = event.action
	const entityType = event.entityType

	if (action === 'created' && entityType === 'relationship') return Link2
	if (action === 'deleted' && entityType === 'relationship') return Unlink
	if (action === 'created') return CircleDot
	if (action === 'updated') return Pencil
	if (action === 'status_changed') return RefreshCw
	if (action === 'deleted') return Trash2
	if (action === 'session_created') return Play
	return Activity
}

function getEntityTitle(event: EventResponse): string | null {
	const data = event.data
	if (!data) return null
	if (typeof data.title === 'string') return data.title
	if (typeof data.updated === 'object' && data.updated && 'title' in data.updated) {
		return (data.updated as Record<string, unknown>).title as string
	}
	return null
}

interface ActivityItemViewProps {
	event: EventResponse
	actor?: ActorResponse
	compact?: boolean
	onNavigate?: (workspaceId: string, entityId: string, entityType?: string) => void
}

export function ActivityItemView({
	event,
	actor,
	compact = false,
	onNavigate,
}: ActivityItemViewProps) {
	const isAgent = actor?.type === 'agent'
	const title = getEntityTitle(event)
	const description = formatEventDescription(event)
	const hasError = isErrorEvent(event)

	const Icon = getEventIcon(event)

	return (
		<div
			className={cn(
				'flex items-start gap-2 animate-slide-in',
				compact ? 'py-1' : 'py-2',
				isAgent && 'opacity-75',
			)}
		>
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-1.5 text-sm">
					<Icon size={14} className="text-muted-foreground shrink-0 relative top-[2px]" />
					<span className={cn('font-medium', isAgent ? 'text-primary' : 'text-foreground')}>
						{actor?.name ?? 'Unknown'}
					</span>
					<span className="text-muted-foreground">{description}</span>
					{title &&
						(onNavigate ? (
							<button
								type="button"
								onClick={() => onNavigate(event.workspaceId, event.entityId, event.entityType)}
								className="text-primary hover:underline cursor-pointer truncate text-sm"
							>
								{title}
							</button>
						) : (
							<span className="text-muted-foreground truncate text-sm">{title}</span>
						))}
					<span className="flex items-center gap-1.5 ml-auto shrink-0">
						{hasError && (
							<Badge variant="destructive" className="text-[10px] px-1 py-0">
								error
							</Badge>
						)}
						<RelativeTime date={event.createdAt} className="text-muted-foreground text-xs" />
					</span>
				</div>
			</div>
		</div>
	)
}

export function ActivityItem({
	event,
	compact = false,
}: {
	event: EventResponse
	compact?: boolean
}) {
	const { data: actor } = useActor(event.actorId)
	const navigate = useNavigate()

	function handleNavigate(workspaceId: string, entityId: string, entityType?: string): void {
		if (entityType === 'notification') {
			navigate({ to: '/$workspaceId', params: { workspaceId } })
			return
		}
		navigate({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId, objectId: entityId },
		})
	}

	return (
		<ActivityItemView event={event} actor={actor} compact={compact} onNavigate={handleNavigate} />
	)
}
