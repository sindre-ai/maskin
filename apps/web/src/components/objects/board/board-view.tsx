import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { useBulkUpdateObjects } from '@/hooks/use-objects'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { Lock } from 'lucide-react'
import { toast } from 'sonner'
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
 * Tasks and insights drag between columns to change status — bet cards are
 * structurally gated (the bet flow owns its transitions).
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
	const bulkUpdate = useBulkUpdateObjects(workspaceId)

	// 5px activation distance separates a click (open object) from a drag
	// (change status). Matches the /work-board precedent.
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

	if (columns.length === 0) {
		return (
			<EmptyState
				title="No statuses configured"
				description={`Add statuses for "${objectType}" in workspace settings to use the board view.`}
			/>
		)
	}

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		if (!over) return
		const dragged = active.data.current?.object as ObjectResponse | undefined
		const toStatus = over.data.current?.status as string | undefined
		if (!dragged || !toStatus) return
		if (dragged.type === 'bet') return
		if (dragged.status === toStatus) return

		bulkUpdate.mutate(
			{ ids: [dragged.id], patch: { status: toStatus } },
			{
				onError: (err) => {
					toast.error(err instanceof Error ? err.message : 'Could not move card')
				},
			},
		)
	}

	return (
		<DndContext sensors={sensors} onDragEnd={handleDragEnd}>
			{objectType === 'bet' && (
				<div
					data-testid="board-bets-gated-banner"
					className="mb-2 flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
				>
					<Lock size={12} aria-hidden />
					<span>Bet cards aren't draggable — bet statuses are gated by the bet flow.</span>
				</div>
			)}

			<div
				data-testid="board-view"
				className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory md:snap-none"
			>
				{columns.map((column) => (
					<BoardColumn
						key={column.status}
						status={column.status}
						objects={column.objects}
						workspaceId={workspaceId}
						actors={actors}
						isLoading={isLoading}
					/>
				))}
			</div>
		</DndContext>
	)
}

interface BoardColumnProps {
	status: string
	objects: ObjectResponse[]
	workspaceId: string
	actors?: ActorListItem[]
	isLoading?: boolean
}

function BoardColumn({ status, objects, workspaceId, actors, isLoading }: BoardColumnProps) {
	const { setNodeRef, isOver, active } = useDroppable({
		id: `col:${status}`,
		data: { status },
	})

	const activeObject = active?.data.current?.object as ObjectResponse | undefined
	const isValidTarget = isOver && activeObject && activeObject.status !== status

	return (
		<div
			ref={setNodeRef}
			data-testid={`board-column-${status}`}
			className={cn(
				'flex shrink-0 snap-center flex-col gap-2 rounded-md transition-colors',
				'w-[85vw] sm:w-72 md:w-72 lg:w-80',
				isValidTarget && 'bg-accent/5 ring-1 ring-accent/30',
			)}
		>
			<div className="flex items-center justify-between px-1">
				<StatusBadge status={status} />
				<span className="text-xs text-muted-foreground tabular-nums">{objects.length}</span>
			</div>

			<div className="flex flex-col gap-2">
				{isLoading ? (
					Array.from({ length: SKELETON_CARDS_PER_COLUMN }).map((_, i) => (
						<CardSkeleton
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
							key={`skeleton-${i}`}
						/>
					))
				) : objects.length === 0 ? (
					<ColumnEmpty />
				) : (
					objects.map((obj) =>
						obj.type === 'bet' ? (
							<BoardCard
								key={obj.id}
								object={obj}
								workspaceId={workspaceId}
								actors={actors}
								gated
							/>
						) : (
							<DraggableBoardCard
								key={obj.id}
								object={obj}
								workspaceId={workspaceId}
								actors={actors}
							/>
						),
					)
				)}
			</div>
		</div>
	)
}

interface DraggableBoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
}

function DraggableBoardCard({ object, workspaceId, actors }: DraggableBoardCardProps) {
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: object.id,
		data: { object },
	})
	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			data-testid="board-card-draggable"
			className={cn('touch-none', isDragging && 'opacity-40')}
		>
			<BoardCard object={object} workspaceId={workspaceId} actors={actors} />
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
