import { ActivityComment } from '@/components/activity/activity-comment'
import { TimelineEventRow, eventChip } from '@/components/activity/timeline-event-row'
import { useActors } from '@/hooks/use-actors'
import type { ActorListItem, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatEventDescription } from '@maskin/shared'
import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

/** Rows shown before the fold — the mockup keeps the three most recent posts
 *  above "N earlier posts in this loop". */
const DEFAULT_LIMIT = 3

// Event actions that represent the loop's agents doing work — the signal
// behind what the loop did last. The endpoint at /api/loops/:id/activity is
// already scoped to session/trigger events, so this set is a defensive filter,
// not the primary gate.
const AGENT_ACTIONS = new Set([
	'session_created',
	'session_running',
	'session_completed',
	'session_failed',
	'session_timeout',
	'session_paused',
	'trigger_fired',
])

type Row =
	| { kind: 'comment'; key: string; time: string | null; event: EventResponse }
	| { kind: 'event'; key: string; time: string | null; event: EventResponse }

/**
 * The loop's Activity stream (mockup 1927–1975). It is the object-detail
 * timeline, read on a loop: the same rail, the same comment bubbles with their
 * threads, and the same event rows — a loop is an object, so what happened to
 * it must never look like a different kind of history.
 */
export function LoopActivity({
	workspaceId,
	loopId,
	activityEvents,
	entityEvents,
}: {
	workspaceId: string
	loopId: string
	/** `/loops/:id/activity` — what the loop's agents did across its children. */
	activityEvents: EventResponse[] | undefined
	/** The loop row's own event log — the source of comments posted on it. */
	entityEvents: EventResponse[] | undefined
}) {
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	// Replies live under their parent so a thread stays intact inside the stream.
	const repliesByParent = useMemo(() => {
		const replies = new Map<number, EventResponse[]>()
		for (const event of entityEvents ?? []) {
			if (event.action !== 'commented') continue
			const parentId = event.data?.parentEventId as number | undefined
			if (!parentId) continue
			const existing = replies.get(parentId) ?? []
			existing.push(event)
			replies.set(parentId, existing)
		}
		return replies
	}, [entityEvents])

	const rows = useMemo(() => {
		const out: Row[] = []
		for (const event of entityEvents ?? []) {
			if (event.action !== 'commented') continue
			if (event.data?.parentEventId) continue
			out.push({ kind: 'comment', key: `comment-${event.id}`, time: event.createdAt, event })
		}
		for (const event of activityEvents ?? []) {
			if (!AGENT_ACTIONS.has(event.action)) continue
			out.push({ kind: 'event', key: `event-${event.id}`, time: event.createdAt, event })
		}
		out.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
		return out
	}, [entityEvents, activityEvents])

	const [expanded, setExpanded] = useState(false)
	const shown = expanded ? rows : rows.slice(0, DEFAULT_LIMIT)
	const hidden = rows.length - DEFAULT_LIMIT

	return (
		<section aria-label="Activity">
			<header className="flex items-center gap-2.5">
				<h2 className="eyebrow">Activity</h2>
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
			</header>

			{rows.length === 0 ? (
				<p className="pt-3.5 text-[12.5px] text-muted-foreground">No activity yet.</p>
			) : (
				<div className="relative pt-2">
					<span aria-hidden="true" className="absolute bottom-3 left-[14px] top-3 w-0.5 bg-muted" />
					<ol className="m-0 list-none p-0">
						{shown.map((row) => (
							<li key={row.key} className="list-none">
								{row.kind === 'comment' ? (
									<ActivityComment
										event={row.event}
										replies={repliesByParent.get(row.event.id) ?? []}
										workspaceId={workspaceId}
										objectId={loopId}
										variant="bubble"
										collapsibleReplies
										persistentReply
									/>
								) : (
									<TimelineEventRow
										time={row.time}
										actorName={actorsById.get(row.event.actorId)?.name ?? 'Someone'}
										text={formatEventDescription(row.event, { actorsById })}
										tone={eventChip(row.event).tone}
										workspaceId={workspaceId}
									/>
								)}
							</li>
						))}
					</ol>

					{hidden > 0 && (
						<div className="relative py-1 pl-9">
							<span
								aria-hidden="true"
								className="absolute left-[11px] top-3 size-[7px] rounded-full bg-border"
							/>
							<button
								type="button"
								aria-expanded={expanded}
								onClick={() => setExpanded((v) => !v)}
								className="inline-flex h-[26px] items-center gap-2 rounded-full border border-dashed border-border bg-card px-3 transition-colors hover:border-border-strong hover:bg-muted"
							>
								<span className="text-[11.5px] font-semibold text-muted-foreground">
									{expanded
										? 'Show less'
										: `${hidden} earlier post${hidden === 1 ? '' : 's'} in this loop`}
								</span>
								<ChevronDown
									size={10}
									aria-hidden="true"
									className={cn(
										'text-muted-foreground transition-transform',
										expanded && 'rotate-180',
									)}
								/>
							</button>
						</div>
					)}
				</div>
			)}
		</section>
	)
}
