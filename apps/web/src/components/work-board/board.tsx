import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { Card } from '@/components/ui/card'
import { Swimlane } from '@/components/work-board/swimlane'
import { useUpdateObject } from '@/hooks/use-objects'
import { type WorkBoardModel, useWorkBoard } from '@/hooks/use-work-board'
import type { ObjectResponse } from '@/lib/api'
import { computeReorderOrder, getTaskOrder } from '@/lib/task-order'
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

interface DragOutcome {
	taskId: string
	data: { status?: string; metadata: Record<string, unknown> }
}

/**
 * Pure resolver for a drag-and-drop result. Returns the patch to apply to
 * the moved task, or `null` for no-op drops (cross-bet, drop-on-self, drop
 * outside any droppable, no actual change). Extracted so the within-column
 * reorder + cross-column status change paths can be unit-tested without
 * spinning up a full `<DndContext>` in jsdom.
 */
export function resolveDragOutcome(
	active: DragEndEvent['active'] | null,
	over: DragEndEvent['over'] | null,
	board: WorkBoardModel,
): DragOutcome | null {
	if (!active || !over) return null
	const task = active.data.current?.task as ObjectResponse | undefined
	const fromLane = active.data.current?.laneId as string | undefined
	const overKind = over.data.current?.kind as 'card' | 'column' | undefined
	const toLane = over.data.current?.laneId as string | undefined
	if (!task || !toLane || !fromLane) return null
	if (fromLane !== toLane) return null

	const lane = board.swimlanes.find((l) => (l.bet?.id ?? 'no-bet') === toLane)

	let toStatus: string | undefined
	let targetIndex: number | undefined
	if (overKind === 'column') {
		toStatus = over.data.current?.status as string | undefined
		if (!toStatus) return null
		targetIndex = lane?.columns[toStatus]?.length ?? 0
	} else if (overKind === 'card') {
		const targetTask = over.data.current?.task as ObjectResponse | undefined
		if (!targetTask) return null
		if (targetTask.id === task.id) return null
		toStatus = targetTask.status
		const column = lane?.columns[toStatus] ?? []
		const idx = column.findIndex((t) => t.id === targetTask.id)
		targetIndex = idx === -1 ? column.length : idx
	} else {
		return null
	}

	if (!toStatus || targetIndex === undefined) return null

	const isStatusChange = task.status !== toStatus
	const targetColumn = lane?.columns[toStatus] ?? []
	const newOrder = computeReorderOrder(targetColumn, task.id, targetIndex)
	const isReorder = getTaskOrder(task) !== newOrder
	if (!isStatusChange && !isReorder) return null

	const data: DragOutcome['data'] = { metadata: { ...(task.metadata ?? {}), order: newOrder } }
	if (isStatusChange) data.status = toStatus
	return { taskId: task.id, data }
}

/**
 * Top-level board: vertical stack of bet swimlanes. Each lane lays out columns
 * for the workspace's task statuses.
 *
 * Drag-and-drop has two gestures:
 * - Drop a card on a different column → status change.
 * - Drop a card on another card in the same swimlane → reorder before the
 *   target card. Within-column reorders persist via `metadata.order` (a
 *   fractional midpoint computed in `task-order.ts`).
 *
 * Both gestures use `useUpdateObject`'s built-in optimistic-then-rollback
 * pattern; failures revert the cache and surface a toast.
 */
export function Board() {
	const { workspaceId } = useWorkspace()
	const { board, isLoading, error } = useWorkBoard()
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
		return (
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
		const outcome = resolveDragOutcome(event.active, event.over, board)
		if (!outcome) return
		updateObject.mutate(
			{ id: outcome.taskId, data: outcome.data },
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
