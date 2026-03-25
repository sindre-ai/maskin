import { useActor } from '@/hooks/use-actors'
import type { ActorResponse, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useNavigate } from '@tanstack/react-router'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'

function formatAction(event: EventResponse): string {
	const action = event.action.replace(/_/g, ' ')
	return `${action} ${event.entityType}`
}

function getEntityTitle(event: EventResponse): string | null {
	const data = event.data
	if (!data) return null
	// Try common shapes from the backend event data
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
					<span className="text-muted-foreground">{formatAction(event)}</span>
					<RelativeTime
						date={event.createdAt}
						className="text-muted-foreground ml-auto text-xs shrink-0"
					/>
				</div>
				{title &&
					!compact &&
					(onNavigate ? (
						<button
							type="button"
							onClick={() => onNavigate(event.workspaceId, event.entityId)}
							className="text-xs text-muted-foreground hover:text-primary truncate block text-left"
						>
							"{title}"
						</button>
					) : (
						<span className="text-xs text-muted-foreground truncate block">"{title}"</span>
					))}
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
