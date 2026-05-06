import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { Card } from '@/components/ui/card'
import type { WorkBoardFilters } from '@/components/work-board/filters'
import { hasActiveFilters } from '@/components/work-board/filters'
import { Swimlane } from '@/components/work-board/swimlane'
import { useUpdateObject } from '@/hooks/use-objects'
import { useWorkBoard } from '@/hooks/use-work-board'
import type { ObjectResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Top-level board: vertical stack of bet swimlanes. Each lane lays out columns
 * for the workspace's task statuses. Cards are draggable between columns
 * within the same swimlane to change the task's status.
 */
export interface BoardProps {
	filters?: WorkBoardFilters
}

export function Board({ filters }: BoardProps = {}) {
	const { workspaceId } = useWorkspace()
	const { board, isLoading, error } = useWorkBoard({ filters })
	const filtersActive = hasActiveFilters(filters ?? {})
	const updateObject = useUpdateObject(workspaceId)

	// 5px activation distance so a click on the card still bubbles for navigation
	// later, and accidental drags from a single tap are filtered out.
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

	const [activeTask, setActiveTask] = useState<ObjectResponse | null>(null)

	if (isLoading) {
		return (
			<div className="flex flex-col gap-3 p-4">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	if (error) {
		return (
			<EmptyState
				title="Could not load the board"
				description={error.message ?? 'Try refreshing the page.'}
			/>
		)
	}

	if (board.swimlanes.length === 0) {
		return filtersActive ? (
			<EmptyState
				title="No tasks match these filters"
				description="Adjust or clear the filters above to see more work."
			/>
		) : (
			<EmptyState
				title="No bets or tasks yet"
				description="Create a bet and break it into tasks to see swimlanes here. Loose tasks land in a 'No bet' lane at the bottom."
			/>
		)
	}

	const handleDragStart = (event: DragStartEvent) => {
		const task = event.active.data.current?.task as ObjectResponse | undefined
		setActiveTask(task ?? null)
	}

	const handleDragEnd = (event: DragEndEvent) => {
		setActiveTask(null)
		const { active, over } = event
		if (!over) return

		const task = active.data.current?.task as ObjectResponse | undefined
		const fromLane = active.data.current?.laneId as string | undefined
		const toLane = over.data.current?.laneId as string | undefined
		const toStatus = over.data.current?.status as string | undefined

		if (!task || !toLane || !toStatus) return
		// Drag is scoped to the same swimlane — moving across bets would change
		// the task's bet membership, which is a separate concern from status.
		if (fromLane !== toLane) return
		if (task.status === toStatus) return

		updateObject.mutate(
			{ id: task.id, data: { status: toStatus } },
			{
				onError: (err) => {
					toast.error(err instanceof Error ? err.message : 'Could not move task')
				},
			},
		)
	}

	return (
		<DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
			<div className="flex flex-col gap-3 p-4">
				{board.swimlanes.map((lane) => (
					<Swimlane key={lane.bet?.id ?? 'no-bet'} lane={lane} />
				))}
			</div>
			<DragOverlay dropAnimation={null}>
				{activeTask ? (
					<Card className="p-3 shadow-md w-72 cursor-grabbing">
						<p className="text-sm font-medium leading-snug line-clamp-2">
							{activeTask.title || 'Untitled task'}
						</p>
					</Card>
				) : null}
			</DragOverlay>
		</DndContext>
	)
}
