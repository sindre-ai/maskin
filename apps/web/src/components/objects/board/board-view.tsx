import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { deriveColumns } from './derive-columns'

interface BoardViewProps {
	objectType: string
	objects: ObjectResponse[]
	statusesByType: Record<string, string[] | undefined>
	isLoading?: boolean
}

const SKELETON_CARDS_PER_COLUMN = 2

/**
 * Scaffold for the Kanban board view. Columns derive from
 * `workspace.settings.statuses[objectType]`. Cards are placeholders — the real
 * `BoardCard` ships in Task 2, drag-and-drop wiring in Task 4.
 */
export function BoardView({ objectType, objects, statusesByType, isLoading }: BoardViewProps) {
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
								<PlaceholderCard
									// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
									key={`skeleton-${i}`}
									skeleton
								/>
							))
						) : column.objects.length === 0 ? (
							<ColumnEmpty />
						) : (
							column.objects.map((obj) => (
								<PlaceholderCard key={obj.id} title={obj.title ?? 'Untitled'} />
							))
						)}
					</div>
				</div>
			))}
		</div>
	)
}

function PlaceholderCard({ title, skeleton }: { title?: string; skeleton?: boolean }) {
	return (
		<div
			data-testid={skeleton ? 'board-card-skeleton' : 'board-card-placeholder'}
			className={cn(
				'rounded-md border border-border bg-card p-3 text-sm',
				skeleton && 'animate-pulse text-transparent',
			)}
		>
			{title ?? 'Loading…'}
		</div>
	)
}

function ColumnEmpty() {
	return <p className="px-1 text-xs text-muted-foreground">Move a task here when work starts.</p>
}
