import { humanizeEvents } from '@/components/dashboard/event-humanizer'
import { RelativeTime } from '@/components/shared/relative-time'
import { Card } from '@/components/ui/card'
import { useActors } from '@/hooks/use-actors'
import { useEvents } from '@/hooks/use-events'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import type { ActorListItem, EventResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useDraggable } from '@dnd-kit/core'
import { useNavigate } from '@tanstack/react-router'
import { Flag } from 'lucide-react'
import { type KeyboardEvent, useMemo } from 'react'
import { AssigneeStack } from './assignee-stack'

interface WorkBoardCardProps {
	task: ObjectResponse
	/** Swimlane id — `bet.id` or `'no-bet'`. Mirrors `Column`'s scoping for DnD. */
	laneId: string
	/** Bet title to render as a chip. Pass `undefined` when the board is grouped by bet (the lane already shows it). */
	betLabel?: string
	/** Click handler for an assignee — wired by Task 5 (filters). */
	onAssigneeClick?: (actorId: string) => void
}

const HEADLINE_EVENT_LIMIT = '50'

/**
 * Rich task card. Anatomy (top → bottom):
 *   1. Title (line-clamp-2, full title via `title` attribute)
 *   2. Live status headline in the actor's voice — derived from `humanizeEvents`
 *   3. Footer: assignee stack (humans + agents, equal weight), optional bet
 *      chip, blocker indicator
 *
 * The card is the most-touched element on the board. Animation budget is one
 * pulsing dot per actively-working agent avatar — nothing else animates.
 */
export function WorkBoardCard({ task, laneId, betLabel, onAssigneeClick }: WorkBoardCardProps) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()

	// Shared workspace queries — TanStack Query dedupes across cards, so the
	// board makes a single round-trip per resource regardless of card count.
	const { data: events } = useEvents(workspaceId, { limit: HEADLINE_EVENT_LIMIT })
	const { data: actors } = useActors(workspaceId)
	const { data: objects } = useObjects(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)

	const headline = useMemo(
		() => deriveHeadline(task.id, events ?? [], actors ?? [], objects ?? []),
		[task.id, events, actors, objects],
	)

	const runningAgentIds = useMemo(() => {
		const set = new Set<string>()
		for (const session of sessions ?? []) {
			if (session.status === 'running') set.add(session.actorId)
		}
		return set
	}, [sessions])

	const assigneeIds = useMemo(
		() => deriveAssignees(task, events ?? [], sessions ?? []),
		[task, events, sessions],
	)

	const isBlocked = task.status === 'blocked'

	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `task:${laneId}:${task.id}`,
		data: { task, laneId },
	})

	// dnd-kit's PointerSensor only fires drag once the activation distance is
	// crossed — a tap-and-release stays a click and routes to the detail page.
	const goToDetail = () => {
		navigate({ to: '/$workspaceId/objects/$objectId', params: { workspaceId, objectId: task.id } })
	}
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			goToDetail()
		}
	}

	return (
		<Card
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			onClick={goToDetail}
			onKeyDown={handleKeyDown}
			className={cn(
				'p-3 shadow-sm cursor-pointer active:cursor-grabbing touch-none select-none',
				'flex flex-col gap-2 hover:bg-muted/40 transition-colors',
				isDragging && 'opacity-40',
				isBlocked && 'border-error/60',
			)}
			data-task-id={task.id}
		>
			<p
				className="text-sm font-medium leading-snug line-clamp-2"
				title={task.title ?? 'Untitled task'}
			>
				{task.title || 'Untitled task'}
			</p>

			{headline ? (
				<p
					className="text-xs text-muted-foreground line-clamp-1"
					title={headline.text}
					data-testid="card-headline"
				>
					{headline.text}
					{headline.timestamp && (
						<>
							<span className="mx-1">·</span>
							<RelativeTime date={headline.timestamp} className="font-mono tabular-nums" />
						</>
					)}
				</p>
			) : (
				<p className="text-xs text-muted-foreground/70">No recent activity</p>
			)}

			<div className="mt-auto flex items-center justify-between gap-2">
				<AssigneeStack
					actorIds={assigneeIds}
					runningAgentIds={runningAgentIds}
					onAssigneeClick={onAssigneeClick}
				/>
				<div className="flex items-center gap-1.5">
					{betLabel && (
						<span
							className="rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground max-w-[120px] truncate"
							title={betLabel}
							data-testid="card-bet-chip"
						>
							{betLabel}
						</span>
					)}
					{isBlocked && (
						<span
							className="inline-flex items-center gap-1 text-error"
							aria-label="Blocked"
							data-testid="card-blocker-flag"
						>
							<Flag size={12} className="fill-error" />
						</span>
					)}
				</div>
			</div>
		</Card>
	)
}

interface Headline {
	text: string
	timestamp: string | null
}

function deriveHeadline(
	taskId: string,
	events: EventResponse[],
	actors: ActorListItem[],
	objects: ObjectResponse[],
): Headline | null {
	// Scope to this task and skip the "Status updated 3m ago" event types the
	// board already reflects spatially (status is the column the card sits in;
	// no need for the headline to say it again).
	const relevant = events.filter((e) => e.entityId === taskId && !isTrivial(e))
	if (relevant.length === 0) return null

	const actorMap = new Map<string, ActorListItem>(actors.map((a) => [a.id, a]))
	const objectMap = new Map<string, ObjectResponse>(objects.map((o) => [o.id, o]))
	const captions = humanizeEvents(
		relevant,
		(id) => (id ? actorMap.get(id) : undefined),
		(id) => (id ? objectMap.get(id) : undefined),
	)
	const head = captions[0]
	if (!head) return null

	const text = renderCaptionText(head)
	return { text, timestamp: head.timestamp }
}

function renderCaptionText(caption: ReturnType<typeof humanizeEvents>[number]): string {
	const body = caption.parts
		.map((part) => {
			if (part.kind === 'text') return part.text
			if (part.kind === 'object') return part.title
			return part.label
		})
		.filter(Boolean)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()
	// Agent voice already starts with "I"; humans get their name prefixed so
	// the headline reads as a complete sentence ("Sebastian shipped X").
	if (caption.actorType === 'agent') return body
	if (!body) return caption.actorName
	return `${caption.actorName} ${body}`
}

const TRIVIAL_ACTIONS = new Set(['session_paused', 'session_running'])

function isTrivial(event: EventResponse): boolean {
	return TRIVIAL_ACTIONS.has(event.action)
}

function deriveAssignees(
	task: ObjectResponse,
	events: EventResponse[],
	sessions: { id: string; actorId: string }[],
): string[] {
	// Equal-assignee model. Until schema-level multi-assignee lands (Task 1's
	// open question on `participates_in` vs `owners[]`), the participant set
	// is the union of: actors on this task's recent events, the actor on
	// `task.activeSessionId`, and `task.owner`. Order is latest-activity-first
	// with `task.owner` appended as a stable anchor, deduped.
	const ordered: string[] = []
	const seen = new Set<string>()
	const push = (id: string | null | undefined) => {
		if (!id || seen.has(id)) return
		seen.add(id)
		ordered.push(id)
	}

	for (const event of events) {
		if (event.entityId !== task.id) continue
		push(event.actorId)
	}

	if (task.activeSessionId) {
		const active = sessions.find((s) => s.id === task.activeSessionId)
		if (active) push(active.actorId)
	}

	push(task.owner)

	return ordered
}
