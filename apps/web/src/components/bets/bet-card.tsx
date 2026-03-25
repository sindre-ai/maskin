import type { ObjectResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { RelativeTime } from '../shared/relative-time'
import { StatusBadge } from '../shared/status-badge'

export function BetCard({
	bet,
	workspaceId,
	insightCount,
	taskCount,
}: {
	bet: ObjectResponse
	workspaceId: string
	insightCount: number
	taskCount: number
}) {
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId: bet.id }}
			className="block rounded-lg border border-border bg-card p-4 shadow-md hover:border-border hover:bg-muted/30 hover:shadow-lg transition-all"
		>
			<div className="flex items-start justify-between gap-2">
				<h3 className="text-sm font-medium text-foreground leading-tight">
					{bet.title || 'Untitled bet'}
				</h3>
				<StatusBadge status={bet.status} />
			</div>
			<div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
				<span>
					{insightCount} insight{insightCount !== 1 ? 's' : ''}
				</span>
				<span className="text-border">·</span>
				<span>
					{taskCount} task{taskCount !== 1 ? 's' : ''}
				</span>
				{bet.updatedAt && (
					<>
						<span className="text-border">·</span>
						<RelativeTime date={bet.updatedAt} />
					</>
				)}
			</div>
		</Link>
	)
}
