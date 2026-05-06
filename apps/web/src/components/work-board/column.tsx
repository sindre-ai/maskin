import { Card } from '@/components/ui/card'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useNavigate } from '@tanstack/react-router'
import type { KeyboardEvent } from 'react'

interface ColumnProps {
	status: string
	tasks: ObjectResponse[]
	/** Swimlane identifier — `bet.id` or `'no-bet'`. Used to scope drags to a single lane. */
	laneId: string
}

const COLUMN_LABELS: Record<string, string> = {
	backlog: 'Backlog',
	todo: 'Todo',
	in_progress: 'In progress',
	in_review: 'In review',
	testing: 'Testing',
	done: 'Done',
}

function formatColumnLabel(status: string): string {
	if (COLUMN_LABELS[status]) return COLUMN_LABELS[status]
	return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function Column({ status, tasks, laneId }: ColumnProps) {
	const isEmpty = tasks.length === 0
	const { setNodeRef, isOver, active } = useDroppable({
		id: `col:${laneId}:${status}`,
		data: { laneId, status, kind: 'column' },
	})
	const activeLaneId = active?.data.current?.laneId as string | undefined
	const isValidTarget = isOver && activeLaneId === laneId
	const isInvalidTarget = isOver && activeLaneId !== undefined && activeLaneId !== laneId

	return (
		<div
			ref={setNodeRef}
			className={cn(
				'flex w-72 shrink-0 flex-col rounded-md border bg-muted/30 transition-colors',
				isValidTarget && 'border-accent bg-accent/5',
				isInvalidTarget && 'opacity-60',
			)}
			data-column-status={status}
		>
			<div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
				<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{formatColumnLabel(status)}
				</span>
				<span
					className={cn(
						'text-xs font-mono tabular-nums',
						isEmpty ? 'text-muted-foreground/60' : 'text-muted-foreground',
					)}
				>
					{tasks.length}
				</span>
			</div>

			<div className="flex flex-col gap-2 p-2 min-h-24">
				{isEmpty ? (
					<p className="text-xs text-muted-foreground/70 px-1 py-2">
						No tasks in {formatColumnLabel(status).toLowerCase()}.
					</p>
				) : (
					tasks.map((task, index) => (
						<TaskCardPlaceholder
							key={task.id}
							task={task}
							laneId={laneId}
							status={status}
							index={index}
						/>
					))
				)}
			</div>
		</div>
	)
}

/**
 * Bare placeholder card. Task 3 replaces this with the rich card (assignees,
 * live status headline, blocker indicator). Kept intentionally minimal here so
 * the layout work can land without the data-density of the full card.
 *
 * Each card is both draggable (the drag source) and droppable (a reorder
 * target). Dropping a card onto another card means "place this card before
 * the target," which lets dnd-kit/core handle within-column reordering
 * without pulling in `@dnd-kit/sortable` as a new dep.
 */
function TaskCardPlaceholder({
	task,
	laneId,
	status,
	index,
}: {
	task: ObjectResponse
	laneId: string
	status: string
	index: number
}) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const {
		attributes,
		listeners,
		setNodeRef: setDragRef,
		isDragging,
	} = useDraggable({
		id: `task:${laneId}:${task.id}`,
		data: { task, laneId, status, index, kind: 'task' },
	})
	const {
		setNodeRef: setDropRef,
		isOver,
		active,
	} = useDroppable({
		id: `taskdrop:${laneId}:${task.id}`,
		data: { task, laneId, status, index, kind: 'card' },
	})
	const setRef = (node: HTMLElement | null) => {
		setDragRef(node)
		setDropRef(node)
	}
	// Only highlight a hovered card when the drag originated in the same
	// swimlane — cross-bet drags are explicitly unsupported in v1.
	const activeLaneId = active?.data.current?.laneId as string | undefined
	const activeTaskId = active?.data.current?.task?.id as string | undefined
	const isReorderTarget = isOver && activeLaneId === laneId && activeTaskId !== task.id
	// dnd-kit's PointerSensor only activates a drag when the pointer moves past
	// the activation distance — a release-in-place produces a normal click event
	// here, so we can route to the detail page without conflicting with drags.
	const handleClick = () => {
		navigate({ to: '/$workspaceId/objects/$objectId', params: { workspaceId, objectId: task.id } })
	}
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			handleClick()
		}
	}
	return (
		<Card
			ref={setRef}
			{...attributes}
			{...listeners}
			onClick={handleClick}
			onKeyDown={handleKeyDown}
			className={cn(
				'p-3 shadow-sm cursor-pointer active:cursor-grabbing touch-none select-none hover:bg-muted/40 transition-colors',
				isDragging && 'opacity-40',
				isReorderTarget && 'ring-2 ring-accent ring-offset-1',
			)}
			data-task-id={task.id}
			data-task-index={index}
		>
			<p className="text-sm font-medium leading-snug line-clamp-2">
				{task.title || 'Untitled task'}
			</p>
		</Card>
	)
}
