import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Checkbox } from '@/components/ui/checkbox'
import { useActor } from '@/hooks/use-actors'
import { useObject } from '@/hooks/use-objects'
import type { EventResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'

// Max tasks rendered inline — keeps a long agent reply from becoming a 50-row
// wall. Mirrors the chip cap in DecisionChips.
const MAX_TASKS = 20

// Statuses we count as "done" for the checkbox. Matches the status taxonomy
// across object types (task, bet, insight) so an agent can list a mix and the
// checklist still reads correctly.
const DONE_STATUSES = new Set(['done', 'completed', 'succeeded', 'success', 'resolved', 'closed'])

// Statuses that should render the row as struck-through (archived/discarded
// without the object actually being deleted).
const ARCHIVED_STATUSES = new Set(['archived', 'discarded', 'cancelled', 'canceled', 'failed'])

function extractTaskIds(event: EventResponse): string[] {
	const metadata = event.data?.metadata as Record<string, unknown> | undefined
	const raw = metadata?.tasks
	if (!Array.isArray(raw)) return []
	const seen = new Set<string>()
	const out: string[] = []
	for (const v of raw) {
		if (typeof v !== 'string') continue
		if (seen.has(v)) continue
		seen.add(v)
		out.push(v)
		if (out.length >= MAX_TASKS) break
	}
	return out
}

export function hasTaskList(event: EventResponse): boolean {
	if (event.action !== 'commented') return false
	return extractTaskIds(event).length > 0
}

function isDone(status: string | null | undefined): boolean {
	if (!status) return false
	return DONE_STATUSES.has(status.toLowerCase())
}

function isArchived(status: string | null | undefined): boolean {
	if (!status) return false
	return ARCHIVED_STATUSES.has(status.toLowerCase())
}

interface TaskRowProps {
	taskId: string
	workspaceId: string
}

function TaskRow({ taskId, workspaceId }: TaskRowProps) {
	const { data: object, isLoading, isError } = useObject(taskId)

	// Loading — skeleton-ish placeholder. Keeps the row height stable so the
	// checklist doesn't reflow under a stream of SSE updates.
	if (isLoading) {
		return (
			<li className="flex items-center gap-2 py-0.5 text-sm text-muted-foreground" aria-busy="true">
				<span className="h-3.5 w-3.5 rounded-sm border border-border" aria-hidden />
				<span className="h-3 w-32 rounded bg-muted/60" aria-hidden />
			</li>
		)
	}

	// Deleted / missing — fetcher returned no object. Reuse the same muted +
	// italic treatment as the inline ObjectReference deleted state so this reads
	// consistently with other places that handle dangling references.
	if (isError || !object) {
		return (
			<li className="flex items-center gap-2 py-0.5">
				<Checkbox disabled aria-label="Deleted task" />
				<span
					className="text-sm italic text-muted-foreground opacity-60"
					title="This task was deleted or is unavailable"
				>
					deleted task
				</span>
			</li>
		)
	}

	return (
		<TaskRowLoaded
			object={object}
			workspaceId={workspaceId}
			checked={isDone(object.status)}
			muted={isArchived(object.status)}
		/>
	)
}

interface TaskRowLoadedProps {
	object: ObjectResponse
	workspaceId: string
	checked: boolean
	muted: boolean
}

function TaskRowLoaded({ object, workspaceId, checked, muted }: TaskRowLoadedProps) {
	// Driver may be null on a brand-new task; only fetch when we have an id so
	// the hook stays disabled and doesn't churn the query cache.
	const driverQuery = useActor(object.driver ?? '')
	const driver = object.driver ? driverQuery.data : null

	return (
		<li className={cn('flex items-center gap-2 py-0.5', muted && 'opacity-60')}>
			<Checkbox
				checked={checked}
				disabled
				aria-label={
					checked ? `Task ${object.title || object.id} done` : `Task ${object.title || object.id}`
				}
			/>
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: object.id }}
				className={cn(
					'text-sm text-foreground hover:underline truncate min-w-0 flex-1',
					muted && 'line-through',
				)}
			>
				{object.title || 'Untitled'}
			</Link>
			{driver && (
				<span
					className="flex items-center gap-1 text-xs text-muted-foreground shrink-0"
					title={`Driver: ${driver.name}`}
				>
					<span aria-hidden>→</span>
					<ActorAvatar name={driver.name} type={driver.type} size="sm" />
					<span className="hidden sm:inline truncate max-w-[8rem]">{driver.name}</span>
				</span>
			)}
		</li>
	)
}

interface CommentTaskListProps {
	event: EventResponse
	workspaceId: string
}

export function CommentTaskList({ event, workspaceId }: CommentTaskListProps) {
	const ids = extractTaskIds(event)
	if (ids.length === 0) return null
	return (
		<ul
			data-testid="comment-task-list"
			className="not-prose mt-1.5 space-y-0.5 rounded-md border border-border/60 bg-card/40 px-2 py-1.5"
		>
			{ids.map((id) => (
				<TaskRow key={id} taskId={id} workspaceId={workspaceId} />
			))}
		</ul>
	)
}
