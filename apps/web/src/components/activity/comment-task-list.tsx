import { useActor } from '@/hooks/use-actors'
import { useObject } from '@/hooks/use-objects'
import { type EventResponse, api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
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
	const seen = new Set<string>()
	const unique: string[] = []
	for (const id of raw) {
		if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id)) continue
		seen.add(id)
		unique.push(id)
		if (unique.length === 25) break
	}
	return unique
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
		<section
			className={cn('mt-1.5 rounded-lg border border-border bg-card', className)}
			aria-label="Tasks referenced by this comment"
		>
			<TaskProgress taskIds={taskIds} />
			<ul className="divide-y divide-border">
				{taskIds.map((taskId) => (
					<TaskRow key={taskId} taskId={taskId} workspaceId={workspaceId} />
				))}
			</ul>
		</section>
	)
}

/** "2 of 4 done" with one segment per task. Reads the same cache entries the
 *  rows do, so it costs no extra requests; hidden until a task has loaded. */
function TaskProgress({ taskIds }: { taskIds: string[] }) {
	const results = useQueries({
		queries: taskIds.map((id) => ({
			queryKey: queryKeys.objects.detail(id),
			queryFn: () => api.objects.get(id),
		})),
	})
	const loaded = results.flatMap((r) => (r.data ? [r.data] : []))
	if (loaded.length === 0) return null
	const doneFlags = results.map((r) => (r.data ? DONE_STATUSES.has(r.data.status) : false))
	const done = doneFlags.filter(Boolean).length
	return (
		<div className="flex items-center gap-2.5 border-b border-border px-3 py-2">
			<span className="text-xs font-semibold text-foreground">
				{done} of {taskIds.length} done
			</span>
			<div aria-hidden="true" className="flex h-1 min-w-0 flex-1 gap-0.5">
				{doneFlags.map((isDone, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
						key={i}
						className={cn('h-full min-w-0 flex-1 rounded-full', isDone ? 'bg-success' : 'bg-muted')}
					/>
				))}
			</div>
		</div>
	)
}

function TaskRow({ taskId, workspaceId }: { taskId: string; workspaceId: string }) {
	const { data: task, isLoading } = useObject(taskId)

	if (isLoading) {
		return (
			<li className="flex items-center gap-2 px-3 py-2">
				<Skeleton className="h-4 w-4 rounded-sm" />
				<Skeleton className="h-4 flex-1" />
			</li>
		)
	}

	if (!task) {
		return (
			<li
				className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground italic opacity-60"
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
		<li className="flex items-center gap-2 px-3 py-2 text-xs max-md:min-h-11">
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
