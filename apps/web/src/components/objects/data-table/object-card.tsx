import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { IndicatorBadgeRow } from '@/components/shared/indicator-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { SourceBadge } from '@/components/shared/source-badge'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

interface ObjectCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected: boolean
	onSelect: (selected: boolean) => void
	onClick: () => void
	betStatus?: BetStatusResult
}

export function ObjectCard({
	object,
	workspaceId,
	actors,
	isSelected,
	onSelect,
	onClick,
	betStatus,
}: ObjectCardProps) {
	const owner = object.driver ? actors?.find((a) => a.id === object.driver) : null
	const isArchived = object.status === 'archived'
	// Prior status is populated by the archive handler (T6) into metadata.previous_status.
	// We only render "was <status>" when it's set; falling back to `object.status` would
	// print "was archived", which is useless.
	const priorStatusRaw = object.metadata?.previous_status
	const priorStatus = typeof priorStatusRaw === 'string' ? priorStatusRaw : null

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: card click supplements the inner Link, which keyboard users tab to and activate with Enter
		<div
			data-state={isSelected ? 'selected' : undefined}
			data-archived={isArchived ? '' : undefined}
			onClick={onClick}
			className={cn(
				'flex w-full items-start gap-3 border-b border-border bg-card px-4 py-3',
				'cursor-pointer transition-[background-color,opacity] hover:bg-accent/30',
				'data-[state=selected]:bg-accent/50',
				isArchived && 'is-archived opacity-[0.62] hover:opacity-90',
			)}
		>
			<Checkbox
				size="touch"
				data-drag-checkbox=""
				checked={isSelected}
				onCheckedChange={(value) => onSelect(!!value)}
				onClick={(e) => e.stopPropagation()}
				aria-label="Select row"
				className="shrink-0 touch-none select-none"
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-w-0 items-start justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: object.id }}
							onClick={(e) => e.stopPropagation()}
							className="truncate text-sm font-medium text-foreground hover:underline"
						>
							{object.title || 'Untitled'}
						</Link>
						{betStatus && <IndicatorBadgeRow result={betStatus} />}
						{object.activeSessionId && (
							<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
						)}
					</div>
					<StatusBadge status={object.status} className="shrink-0" />
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<TypeBadge type={object.type} />
					{object.metadata?.source === 'behavioral' && <SourceBadge source="behavioral" />}
					{isArchived && priorStatus && (
						<span className="truncate">was {priorStatus.replace(/_/g, ' ')}</span>
					)}
					{owner && <span className="truncate">{owner.name}</span>}
					{object.updatedAt && (
						<RelativeTime date={object.updatedAt} className="ml-auto shrink-0" />
					)}
				</div>
			</div>
		</div>
	)
}
