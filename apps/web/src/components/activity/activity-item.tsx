import { useActor } from '@/hooks/use-actors'
import type { ActorListItem, ActorResponse, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatEventDescription, isErrorEvent } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'
import { Badge } from '../ui/badge'

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight'])
const SESSION_ACTIONS = new Set([
	'session_created',
	'session_running',
	'session_completed',
	'session_failed',
	'session_timeout',
	'session_paused',
])

function isObjectEntity(entityType: string): boolean {
	return OBJECT_ENTITY_TYPES.has(entityType)
}

function isSessionEvent(event: EventResponse): boolean {
	return SESSION_ACTIONS.has(event.action)
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
	workspaceId?: string
	/** When set and matches event.entityId, the entity title is hidden (used on the object detail page to avoid repeating the page's own title). */
	contextEntityId?: string
	actorsById?: Map<string, ActorListItem>
	/** Replaces the default formatted description (used by the timeline to render compact "set the status to X" rows under phase dividers). */
	descriptionOverride?: string
}

export function ActivityItemView({
	event,
	actor,
	compact = false,
	workspaceId,
	contextEntityId,
	actorsById,
	descriptionOverride,
}: ActivityItemViewProps) {
	const isAgent = actor?.type === 'agent'
	const title = getEntityTitle(event)
	const description = descriptionOverride ?? formatEventDescription(event, { actorsById })
	const hasError = isErrorEvent(event)

	const isSession = isSessionEvent(event)
	const isClickable = isSession && workspaceId && event.actorId

	const hideTitle =
		contextEntityId !== undefined &&
		contextEntityId === event.entityId &&
		isObjectEntity(event.entityType)
	const showTitle = !hideTitle && title

	const content = (
		<div
			className={cn(
				'flex items-start gap-2 animate-slide-in',
				compact ? 'py-1' : 'py-2',
				isAgent && 'opacity-75',
				isClickable &&
					'hover:bg-secondary/50 rounded-md px-1 -mx-1 transition-colors cursor-pointer',
			)}
		>
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-1.5 text-sm flex-wrap">
					{isAgent ? (
						<span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-xs font-medium shrink-0">
							{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
							<span>{actor?.name ?? 'Agent'}</span>
						</span>
					) : (
						<span className="font-medium text-foreground">{actor?.name ?? 'Unknown'}</span>
					)}
					<span className="text-muted-foreground break-words min-w-0">{description}</span>
					{showTitle &&
						(workspaceId && isObjectEntity(event.entityType) ? (
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId: event.entityId }}
								className="text-foreground hover:underline truncate text-sm min-w-0 max-w-full"
								onClick={(e) => e.stopPropagation()}
							>
								{title}
							</Link>
						) : (
							<span className="text-muted-foreground truncate text-sm min-w-0 max-w-full">
								{title}
							</span>
						))}
					<RelativeTime date={event.createdAt} className="text-muted-foreground text-xs" />
					{hasError && (
						<Badge variant="destructive" className="text-[10px] px-1 py-0">
							error
						</Badge>
					)}
				</div>
			</div>
		</div>
	)

	if (isClickable) {
		return (
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: event.actorId }}
				className="block no-underline text-inherit"
			>
				{content}
			</Link>
		)
	}

	return content
}

export function ActivityItem({
	event,
	compact = false,
	contextEntityId,
	actorsById,
	descriptionOverride,
}: {
	event: EventResponse
	compact?: boolean
	contextEntityId?: string
	actorsById?: Map<string, ActorListItem>
	descriptionOverride?: string
}) {
	const { data: actor } = useActor(event.actorId)

	return (
		<ActivityItemView
			event={event}
			actor={actor}
			compact={compact}
			workspaceId={event.workspaceId}
			contextEntityId={contextEntityId}
			actorsById={actorsById}
			descriptionOverride={descriptionOverride}
		/>
	)
}
