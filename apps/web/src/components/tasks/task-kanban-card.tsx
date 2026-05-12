import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { Spinner } from '@/components/ui/spinner'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight } from 'lucide-react'

interface TaskKanbanCardProps {
	task: ObjectResponse
	parentTitle?: string
	/** When true, hides the parent bet eyebrow (used when already grouped by bet) */
	hideParent?: boolean
	/** When true, hides owner in footer (used when grouped by owner) */
	hideOwner?: boolean
	compact?: boolean
}

export function TaskKanbanCard({
	task,
	parentTitle,
	hideParent = false,
	hideOwner = false,
	compact = false,
}: TaskKanbanCardProps) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const status = task.status
	const isDone = status === 'done'
	const isInProgress = status === 'in_progress'
	const isBlocked = status === 'blocked'
	const isReview = status === 'review'
	const isHighPriority = task.metadata?.priority === 'high'
	const blockedBy = task.metadata?.blocked_by as string | undefined
	const reviewer = task.metadata?.reviewer as string | undefined
	const ownerName = task.owner ?? ''
	const ownerType = task.metadata?.owner_type as string | undefined

	const handleClick = () => {
		navigate({ to: '/$workspaceId/objects/$objectId', params: { workspaceId, objectId: task.id } })
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			className={cn(
				'group flex flex-col gap-1.5 rounded-md px-2.5 py-2 cursor-pointer w-full text-left',
				'transition-colors duration-150',
				'hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus',
				isBlocked && 'hover:bg-error/5',
			)}
		>
			{/* Eyebrow: parent bet title + priority badge */}
			{(!hideParent || isHighPriority) && (
				<div className="flex items-center gap-2 min-h-[14px]">
					{!hideParent && parentTitle && (
						<span className="flex-1 min-w-0 text-[11px] text-text-muted truncate font-medium">
							{parentTitle}
						</span>
					)}
					{!parentTitle && !hideParent && <span className="flex-1" />}
					{isHighPriority && (
						<span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-error">
							High
						</span>
					)}
				</div>
			)}

			{/* Title */}
			<p
				className={cn(
					'text-[12.5px] font-medium leading-snug',
					isDone ? 'text-text-muted line-through decoration-text-muted/50' : 'text-text',
				)}
			>
				{task.title ?? 'Untitled'}
			</p>

			{/* Status-specific aux info — only in comfy mode */}
			{!compact && (
				<>
					{isInProgress && (
						<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-accent">
							<Spinner className="size-3" />
							<span>Running</span>
						</div>
					)}
					{isBlocked && blockedBy && (
						<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-error">
							<AlertTriangle size={11} />
							<span className="truncate">{blockedBy}</span>
						</div>
					)}
					{isReview && reviewer && (
						<div className="flex items-center gap-1.5 text-[11.5px] text-text-secondary">
							<ArrowRight size={11} />
							<span className="truncate">{reviewer}</span>
						</div>
					)}
				</>
			)}

			{/* Footer: owner + timestamp */}
			<div className="flex items-center gap-2 pt-1 border-t border-border/60">
				{!hideOwner && ownerName && (
					<span className="flex items-center gap-1.5 text-[11px] text-text-muted font-medium min-w-0">
						<ActorAvatar name={ownerName} type={ownerType ?? 'human'} size="sm" />
						<span className="truncate">{ownerName}</span>
					</span>
				)}
				<span className="flex-1" />
				<RelativeTime
					date={task.updatedAt}
					className="text-[10.5px] font-mono text-text-muted tabular-nums"
				/>
			</div>
		</button>
	)
}
