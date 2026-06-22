import { useActor } from '@/hooks/use-actors'
import { useObject } from '@/hooks/use-objects'
import type { EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ActorAvatar } from '../shared/actor-avatar'
import { Skeleton } from '../shared/loading-skeleton'
import { Checkbox } from '../ui/checkbox'

const DONE_STATUSES = new Set(['done', 'completed', 'succeeded'])
const MUTED_STATUSES = new Set(['archived', 'discarded', 'cancelled', 'canceled'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function extractTasks(event: EventResponse): string[] {
	const metadata = event.data?.metadata as Record<string, unknown> | undefined
	const raw = metadata?.tasks
	if (!Array.isArray(raw)) return []
	return raw.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)).slice(0, 25)
}

export function hasTaskList(event: EventResponse): boolean {
	if (event.action !== 'commented') return false
	return extractTasks(event).length > 0
}

interface CommentTaskListProps {
	event: EventResponse
	workspaceId: string
	className?: string
}

export function CommentTaskList({ event, workspaceId, className }: CommentTaskListProps) {
	const taskIds = extractTasks(event)
	if (taskIds.length === 0) return null
	return (
		<ul
			className={cn(
				'mt-1.5 space-y-1 rounded-md border border-border/70 bg-card/40 p-2',
				className,
			)}
			aria-label="Tasks referenced by this comment"
		>
			{taskIds.map((taskId) => (
				<TaskRow key={taskId} taskId={taskId} workspaceId={workspaceId} />
			))}
		</ul>
	)
}

function TaskRow({ taskId, workspaceId }: { taskId: string; workspaceId: string }) {
	const { data: task, isLoading } = useObject(taskId)

	if (isLoading) {
		return (
			<li className="flex items-center gap-2 py-0.5">
				<Skeleton className="h-4 w-4 rounded-sm" />
				<Skeleton className="h-4 flex-1" />
			</li>
		)
	}

	if (!task) {
		return (
			<li
				className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground italic opacity-60"
				title="This task was deleted or is unavailable"
			>
				<Checkbox checked={false} disabled aria-label="Deleted task" />
				<span className="line-through">deleted task</span>
			</li>
		)
	}

	const isDone = DONE_STATUSES.has(task.status)
	const isMuted = MUTED_STATUSES.has(task.status)

	return (
		<li className="flex items-center gap-2 py-0.5 text-xs">
			<Checkbox checked={isDone} disabled aria-label={`Task ${task.title} is ${task.status}`} />
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: task.id }}
				className={cn(
					'flex-1 min-w-0 truncate text-foreground hover:underline',
					isMuted && 'line-through text-muted-foreground opacity-70',
					isDone && !isMuted && 'text-muted-foreground',
				)}
			>
				{task.title || 'Untitled task'}
			</Link>
			<TaskDriver driverId={task.driver} />
		</li>
	)
}

function TaskDriver({ driverId }: { driverId: string | null | undefined }) {
	const { data: actor } = useActor(driverId ?? '')
	if (!driverId || !actor) return null
	return (
		<span
			className="flex items-center gap-1 shrink-0 text-[11px] text-muted-foreground"
			title={`Driver: ${actor.name}`}
		>
			<span aria-hidden>→</span>
			<ActorAvatar name={actor.name} type={actor.type} size="sm" />
		</span>
	)
}
