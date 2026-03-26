import { useActor } from '@/hooks/use-actors'
import type { ActorResponse, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNavigate } from '@tanstack/react-router'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'
import { Badge } from '../ui/badge'
import { formatEventDescription, isErrorEvent } from './format-event'

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
	onNavigate?: (workspaceId: string, objectId: string) => void
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
					<span className={cn('font-medium', isAgent ? 'text-primary' : 'text-foreground')}>
						{actor?.name ?? 'Unknown'}
					</span>
					<span className="text-muted-foreground">{description}</span>
					{title &&
						(onNavigate ? (
							<button
								type="button"
								onClick={() => onNavigate(event.workspaceId, event.entityId)}
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

	function handleNavigate(workspaceId: string, objectId: string): void {
		navigate({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId, objectId },
		})
	}

	return (
		<ActivityItemView event={event} actor={actor} compact={compact} onNavigate={handleNavigate} />
	)
}
