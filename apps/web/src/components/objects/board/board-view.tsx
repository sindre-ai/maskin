import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { BoardCard } from './board-card'
import { deriveColumns } from './derive-columns'

interface BoardViewProps {
	objectType: string
	objects: ObjectResponse[]
	statusesByType: Record<string, string[] | undefined>
	workspaceId: string
	actors?: ActorListItem[]
	isLoading?: boolean
}

const SKELETON_CARDS_PER_COLUMN = 2

/**
 * Kanban board view. Columns derive from `workspace.settings.statuses[objectType]`.
 * Drag-and-drop wiring lands in Task 4.
 */
export function BoardView({
	objectType,
	objects,
	statusesByType,
	workspaceId,
	actors,
	isLoading,
}: BoardViewProps) {
	const columns = deriveColumns(objectType, statusesByType, objects)

	if (columns.length === 0) {
		return (
			<EmptyState
				title="No statuses configured"
				description={`Add statuses for "${objectType}" in workspace settings to use the board view.`}
			/>
		)
	}

	return (
		<div
			data-testid="board-view"
			className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory md:snap-none"
		>
			{columns.map((column) => (
				<div
					key={column.status}
					className={cn(
						'flex shrink-0 snap-center flex-col gap-2',
						'w-[85vw] sm:w-72 md:w-72 lg:w-80',
					)}
				>
					<div className="flex items-center justify-between px-1">
						<StatusBadge status={column.status} />
						<span className="text-xs text-muted-foreground tabular-nums">
							{column.objects.length}
						</span>
					</div>

					<div className="flex flex-col gap-2">
						{isLoading ? (
							Array.from({ length: SKELETON_CARDS_PER_COLUMN }).map((_, i) => (
								<CardSkeleton
									// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
									key={`skeleton-${i}`}
								/>
							))
						) : column.objects.length === 0 ? (
							<ColumnEmpty />
						) : (
							column.objects.map((obj) => (
								<BoardCard key={obj.id} object={obj} workspaceId={workspaceId} actors={actors} />
							))
						)}
					</div>
				</div>
			))}
		</div>
	)
}

function CardSkeleton() {
	return (
		<div
			data-testid="board-card-skeleton"
			className="h-16 animate-pulse rounded-md border border-border bg-card"
		/>
	)
}

function ColumnEmpty() {
	return <p className="px-1 text-xs text-muted-foreground">Move a task here when work starts.</p>
}
