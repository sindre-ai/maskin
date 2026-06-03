import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { Lock } from 'lucide-react'

interface BoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	/** Render the card in a non-draggable, visually-gated state. Used for bet cards. */
	gated?: boolean
}

export function BoardCard({ object, workspaceId, actors, gated }: BoardCardProps) {
	const owner = object.owner ? actors?.find((a) => a.id === object.owner) : null

	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: object.id }}
			data-testid="board-card"
			data-gated={gated ? 'true' : undefined}
			className={cn(
				'relative flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				gated && 'border-dashed',
			)}
		>
			{gated && (
				<span
					aria-label="Gated"
					title="Bet status is gated — only the agent flow can move it."
					className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
				>
					<Lock size={10} aria-hidden />
					Gated
				</span>
			)}

			<div className="flex items-start justify-between gap-2">
				<span className={cn('line-clamp-2 min-w-0 font-medium text-foreground', gated && 'pr-16')}>
					{object.title || 'Untitled'}
				</span>
				{!gated && <StatusBadge status={object.status} className="shrink-0" />}
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
