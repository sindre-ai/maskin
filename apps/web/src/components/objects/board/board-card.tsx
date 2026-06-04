import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

interface BoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected?: boolean
}

export function BoardCard({ object, workspaceId, actors, isSelected }: BoardCardProps) {
	const owner = object.owner ? actors?.find((a) => a.id === object.owner) : null

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-testid="board-card"
			data-state={isSelected ? 'selected' : undefined}
			aria-selected={isSelected}
			className={cn(
				'relative flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				'data-[state=selected]:border-accent data-[state=selected]:bg-accent/40 data-[state=selected]:ring-2 data-[state=selected]:ring-accent/30',
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<span className="line-clamp-2 min-w-0 font-medium text-foreground">
					{object.title || 'Untitled'}
				</span>
				<StatusBadge status={object.status} className="shrink-0" />
			</div>

			{object.activeSessionId && (
				<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
			)}

			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
				<TypeBadge type={object.type} />
				{owner && <span className="truncate">{owner.name}</span>}
				{object.updatedAt && <RelativeTime date={object.updatedAt} className="ml-auto shrink-0" />}
			</div>
		</Link>
	)
}
