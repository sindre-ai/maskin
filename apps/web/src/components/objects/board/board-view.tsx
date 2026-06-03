import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { useBulkUpdateObjects } from '@/hooks/use-objects'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	PointerSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { useState } from 'react'
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

function humanizeStatus(status: string) {
	return status.replace(/_/g, ' ')
}

/**
 * Kanban board view. Columns derive from `workspace.settings.statuses[objectType]`
 * and every object type uses the same drag-to-status flow.
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
	const [activeObject, setActiveObject] = useState<ObjectResponse | null>(null)

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
		setActiveObject(null)
		if (!over) return
		const dragged = active.data.current?.object as ObjectResponse | undefined
		const toStatus = over.data.current?.status as string | undefined
		if (!dragged || !toStatus) return
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
		<DndContext
			sensors={sensors}
			onDragStart={({ active }) => {
				const object = active.data.current?.object as ObjectResponse | undefined
				setActiveObject(object ?? null)
			}}
			onDragCancel={() => setActiveObject(null)}
			onDragEnd={handleDragEnd}
		>
			<div
				data-testid="board-view"
				className={cn(
					'flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory md:snap-none',
					activeObject && 'cursor-grabbing',
				)}
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
			<DragOverlay dropAnimation={null}>
				{activeObject ? (
					<div className="pointer-events-none cursor-grabbing rotate-2 scale-[1.02] shadow-lg">
						<BoardCard object={activeObject} workspaceId={workspaceId} actors={actors} />
					</div>
				) : null}
			</DragOverlay>
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
				'relative flex min-h-[28rem] shrink-0 snap-center flex-col gap-2 rounded-md transition-colors',
				'w-[85vw] sm:w-72 md:w-72 lg:w-80',
				isValidTarget && 'bg-accent/5',
			)}
		>
			<div className="flex items-center justify-between px-1">
				<StatusBadge status={status} />
				<span className="text-xs text-muted-foreground tabular-nums">{objects.length}</span>
			</div>

			<div
				className={cn(
					'relative flex min-h-24 flex-col gap-2 rounded-md transition-colors',
					isValidTarget &&
						'border border-dashed border-border/70 bg-accent/10 ring-1 ring-accent/15',
				)}
			>
				{isLoading ? (
					<div className="flex flex-col gap-2">
						{Array.from({ length: SKELETON_CARDS_PER_COLUMN }).map((_, i) => (
							<CardSkeleton
								// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
								key={`skeleton-${i}`}
							/>
						))}
					</div>
				) : objects.length === 0 ? (
					isValidTarget ? (
						<div className="pointer-events-none min-h-14 rounded-md border border-dashed border-border/70 bg-accent/20 px-3 py-3 text-xs text-muted-foreground">
							Drop here to move to {humanizeStatus(status)}.
						</div>
					) : (
						<ColumnEmpty status={status} />
					)
				) : (
					<div className="flex flex-col gap-2">
						{objects.map((obj) => (
							<DraggableBoardCard
								key={obj.id}
								object={obj}
								workspaceId={workspaceId}
								actors={actors}
							/>
						))}
					</div>
				)}
				{isValidTarget && objects.length > 0 && (
					<div className="pointer-events-none min-h-14 rounded-md border border-dashed border-border/70 bg-accent/20 px-3 py-3 text-xs text-muted-foreground">
						Drop here to move to {humanizeStatus(status)}.
					</div>
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
			className={cn(
				'touch-none select-none cursor-grab active:cursor-grabbing',
				isDragging && 'cursor-grabbing opacity-40',
			)}
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

function ColumnEmpty({ status }: { status: string }) {
	return (
		<div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
			<p>Nothing here yet.</p>
			<p className="mt-1">Drag a card to {humanizeStatus(status)}.</p>
		</div>
	)
}
