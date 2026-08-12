import { ActivityComment } from '@/components/activity/activity-comment'
import { ActivityItem } from '@/components/activity/activity-item'
import { computeUnreadEventIds } from '@/components/activity/object-activity'
import { EmptyState } from '@/components/shared/empty-state'
import { UnreadBadge } from '@/components/shared/unread-badge'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useObjectGraph } from '@/hooks/use-objects'
import type { ActorListItem, EventResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { formatStatusTransitionShort } from '@maskin/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

type ActivityFilter = 'all' | 'comments' | 'status' | 'updates'

const FILTERS: Array<{ id: ActivityFilter; label: string }> = [
	{ id: 'all', label: 'All' },
	{ id: 'comments', label: 'Comments' },
	{ id: 'status', label: 'Status' },
	{ id: 'updates', label: 'Updates' },
]

/**
 * Filterable activity feed for the object detail page (T2). Receives the
 * object and renders real activity events from the object graph, with
 * per-filter counts and an unread jump. Self-contained — mounted by T5 into
 * the page's tab bar.
 */
export function ActivityTab({ object }: { object: ObjectResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: graph } = useObjectGraph(workspaceId, object.id)
	const events = graph?.events

	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	// Events arrive sorted desc (newest first); bucket replies under their
	// parent comment so threads stay intact within the flat list.
	const { topLevel, repliesByParent } = useMemo(() => {
		const top: EventResponse[] = []
		const replies = new Map<number, EventResponse[]>()
		for (const event of events ?? []) {
			if (event.action === 'commented') {
				const parentId = event.data?.parentEventId as number | undefined
				if (parentId) {
					const existing = replies.get(parentId) ?? []
					existing.push(event)
					replies.set(parentId, existing)
					continue
				}
			}
			top.push(event)
		}
		return { topLevel: top, repliesByParent: replies }
	}, [events])

	const counts = useMemo(() => {
		const comments = topLevel.filter((e) => e.action === 'commented').length
		const status = topLevel.filter((e) => e.action === 'status_changed').length
		return { all: topLevel.length, comments, status, updates: topLevel.length - comments - status }
	}, [topLevel])

	const [filter, setFilter] = useState<ActivityFilter>('all')
	const visible = useMemo(() => {
		if (filter === 'all') return topLevel
		return topLevel.filter((e) => {
			if (filter === 'comments') return e.action === 'commented'
			if (filter === 'status') return e.action === 'status_changed'
			return e.action !== 'commented' && e.action !== 'status_changed'
		})
	}, [filter, topLevel])

	// Unread = the most recent `unread_count` comment events (mirrors the
	// server high-water-mark). Jump targets the first unread *top-level* comment
	// thread, since replies render inside their parent's row without their own
	// anchor.
	const unreadCount = object.unread_count ?? 0
	const unreadEventIds = useMemo(
		() => computeUnreadEventIds(events, unreadCount),
		[events, unreadCount],
	)
	const firstUnreadId = useMemo(() => {
		if (unreadEventIds.size === 0) return null
		let min: number | null = null
		for (const e of topLevel) {
			if (e.action === 'commented' && unreadEventIds.has(e.id)) {
				if (min === null || e.id < min) min = e.id
			}
		}
		return min
	}, [unreadEventIds, topLevel])

	const containerRef = useRef<HTMLDivElement>(null)
	const [jumpTick, setJumpTick] = useState(0)
	useEffect(() => {
		if (jumpTick === 0 || firstUnreadId === null) return
		const el = containerRef.current?.querySelector(`#comment-${firstUnreadId}`)
		el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
	}, [jumpTick, firstUnreadId])

	const handleJumpToFirstUnread = () => {
		if (firstUnreadId === null) return
		// Reset to All so the (possibly filtered-out) unread thread is rendered,
		// then let the effect scroll once the anchor exists.
		setFilter('all')
		setJumpTick((t) => t + 1)
	}

	return (
		<div className="w-full min-w-0">
			<div className="mb-3 flex items-center justify-between gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Activity
					<UnreadBadge count={unreadCount} className="ml-2 normal-case tracking-normal" />
				</h3>
				{firstUnreadId !== null && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						onClick={handleJumpToFirstUnread}
					>
						Jump to first unread
					</Button>
				)}
			</div>

			<fieldset className="mb-4 m-0 inline-flex items-center rounded-md border border-border bg-background p-0.5">
				<legend className="sr-only">Activity filter</legend>
				{FILTERS.map((f) => {
					const active = filter === f.id
					return (
						<button
							key={f.id}
							type="button"
							onClick={() => setFilter(f.id)}
							aria-pressed={active}
							className={cn(
								'inline-flex h-6 items-center gap-1 rounded-sm px-2 text-[11px] font-medium capitalize transition-colors',
								active
									? 'bg-secondary text-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{f.label}
							<span
								className={cn('tabular-nums', active ? 'text-foreground' : 'text-muted-foreground')}
							>
								{counts[f.id]}
							</span>
						</button>
					)
				})}
			</fieldset>

			{visible.length === 0 ? (
				<EmptyState
					title="No activity yet"
					description="Activity for this object will appear here."
				/>
			) : (
				<ul ref={containerRef} className="space-y-1">
					{visible.map((event) => (
						<li key={event.id} className="list-none">
							{event.action === 'commented' ? (
								<ActivityComment
									event={event}
									replies={repliesByParent.get(event.id) ?? []}
									workspaceId={workspaceId}
									objectId={object.id}
									isUnread={unreadEventIds.has(event.id)}
								/>
							) : (
								<ActivityItem
									event={event}
									compact
									contextEntityId={object.id}
									actorsById={actorsById}
									descriptionOverride={
										event.action === 'status_changed'
											? formatStatusTransitionShort(event)
											: undefined
									}
								/>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
