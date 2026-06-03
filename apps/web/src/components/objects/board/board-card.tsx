import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'

interface BoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
}

export function BoardCard({ object, workspaceId, actors }: BoardCardProps) {
	const owner = object.owner ? actors?.find((a) => a.id === object.owner) : null

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-testid="board-card"
			className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
