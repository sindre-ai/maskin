import { Card } from '@/components/ui/card'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'

interface ColumnProps {
	status: string
	tasks: ObjectResponse[]
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

export function Column({ status, tasks }: ColumnProps) {
	const isEmpty = tasks.length === 0
	return (
		<div
			className="flex w-72 shrink-0 flex-col rounded-md border bg-muted/30"
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
					tasks.map((task) => <TaskCardPlaceholder key={task.id} task={task} />)
				)}
			</div>
		</div>
	)
}

/**
 * Bare placeholder card. Task 3 replaces this with the rich card (assignees,
 * live status headline, blocker indicator). Kept intentionally minimal here so
 * the layout work can land without the data-density of the full card.
 */
function TaskCardPlaceholder({ task }: { task: ObjectResponse }) {
	return (
		<Card className="p-3 shadow-sm" data-task-id={task.id}>
			<p className="text-sm font-medium leading-snug line-clamp-2">
				{task.title || 'Untitled task'}
			</p>
		</Card>
	)
}
