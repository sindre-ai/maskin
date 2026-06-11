import { useActors } from '@/hooks/use-actors'
import { useEventVisible } from '@/hooks/use-event-visible'
import { useMentionSessionsForObject } from '@/hooks/use-sessions'
import { useMarkRead } from '@/hooks/use-subscriptions'
import type { ActorListItem, EventResponse, ObjectResponse, SessionResponse } from '@/lib/api'
import { usePendingCommentsForObject } from '@/lib/pending-comments-context'
import {
	type SessionMentionContext,
	type SessionThreadReplyContext,
	formatStatusTransitionShort,
} from '@maskin/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StreamingIndicator } from '../shared/streaming-indicator'
import { UnreadBadge } from '../shared/unread-badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent } from '../ui/collapsible'
import { ActivityComment } from './activity-comment'
import { ActivityItem } from './activity-item'
import { buildPhases } from './build-phases'
import { CommentInput } from './comment-input'
import { PendingCommentRow } from './pending-comment-row'
import { PhaseDivider } from './phase-divider'

interface ObjectActivityProps {
	workspaceId: string
	object: ObjectResponse
	events?: EventResponse[]
	activeSessionId?: string | null
}

export function ObjectActivity({
	workspaceId,
	object,
	events,
	activeSessionId,
}: ObjectActivityProps) {
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	// Latest commented-event id on this object — used as the high-water-mark
	// when the user scrolls past the end of the activity list, and as the
	// payload for the fallback "Mark all as read" button.
	const latestEventId = useMemo(() => {
		if (!events) return 0
		let max = 0
		for (const e of events) {
			if (e.action === 'commented' && e.id > max) max = e.id
		}
		return max
	}, [events])

	const markRead = useMarkRead(workspaceId)
	const markedRef = useRef(0)
	// Reset the per-object high-water-mark when navigating between objects —
	// the component instance may be reused by the router, so a stale value
	// from object A would suppress a valid mark-read for object B.
	// biome-ignore lint/correctness/useExhaustiveDependencies: object.id is the trigger, not a value read inside.
	useEffect(() => {
		markedRef.current = 0
	}, [object.id])
	const unreadCount = object.unread_count ?? 0

	// The most recent `unreadCount` comment events (by descending ID) are considered unread.
	// This mirrors the high-water-mark the server uses for mark-read tracking.
	const unreadEventIds = useMemo(
		() => computeUnreadEventIds(events, unreadCount),
		[events, unreadCount],
	)

	const handleSeenBottom = useCallback(
		(eventId: number) => {
			if (eventId <= 0) return
			if (eventId <= markedRef.current) return
			markedRef.current = eventId
			markRead.mutate({ entityType: 'object', entityId: object.id, lastEventId: eventId })
		},
		[markRead, object.id],
	)

	const sentinelRef = useEventVisible(latestEventId, handleSeenBottom)

	const handleMarkAllRead = () => {
		if (latestEventId <= 0) return
		markedRef.current = latestEventId
		markRead.mutate({
			entityType: 'object',
			entityId: object.id,
			lastEventId: latestEventId,
		})
	}

	const { data: mentionSessions } = useMentionSessionsForObject(workspaceId, object.id)
	const sessionsByComment = useMemo(() => {
		const map = new Map<number, SessionResponse[]>()
		for (const session of mentionSessions ?? []) {
			const config = session.config as {
				mention?: SessionMentionContext
				thread_reply?: SessionThreadReplyContext
			} | null
			const commentEventId =
				config?.mention?.comment_event_id ?? config?.thread_reply?.comment_event_id
			if (commentEventId === undefined) continue
			const existing = map.get(commentEventId) ?? []
			existing.push(session)
			map.set(commentEventId, existing)
		}
		return map
	}, [mentionSessions])

	// Events arrive from the API sorted desc (newest first); reverse for chronological grouping.
	// Then bucket replies under their parent comment so threads stay intact within phases.
	const { phases, repliesByParent, totalTopLevel } = useMemo(() => {
		if (!events) {
			return {
				phases: [] as ReturnType<typeof buildPhases>,
				repliesByParent: new Map<number, EventResponse[]>(),
				totalTopLevel: 0,
			}
		}

		const chronological = [...events].reverse()

		const replies = new Map<number, EventResponse[]>()
		const topLevel: EventResponse[] = []
		for (const event of chronological) {
			if (event.action === 'commented') {
				const parentId = event.data?.parentEventId as number | undefined
				if (parentId) {
					const existing = replies.get(parentId) ?? []
					existing.push(event)
					replies.set(parentId, existing)
					continue
				}
			}
			topLevel.push(event)
		}

		const visiblePhases = buildPhases(topLevel, object).filter((p) => p.events.length > 0)

		return {
			phases: visiblePhases,
			repliesByParent: replies,
			totalTopLevel: topLevel.length,
		}
	}, [events, object])

	// Only the current (last) phase is expanded by default; users can toggle any other.
	const [phaseOverrides, setPhaseOverrides] = useState<Record<number, boolean>>({})
	const currentPhaseIndex = phases.length - 1
	const isPhaseOpen = (index: number) => phaseOverrides[index] ?? index === currentPhaseIndex
	const togglePhase = (index: number) => {
		setPhaseOverrides((prev) => ({ ...prev, [index]: !isPhaseOpen(index) }))
	}

	return (
		<div className="border-t border-border pt-6">
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Activity
					<UnreadBadge count={unreadCount} className="ml-2 normal-case tracking-normal" />
				</h3>
				{unreadCount > 0 && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						onClick={handleMarkAllRead}
						disabled={markRead.isPending}
					>
						Mark all as read
					</Button>
				)}
			</div>

			{activeSessionId && (
				<div className="mb-3">
					<StreamingIndicator sessionId={activeSessionId} workspaceId={workspaceId} />
				</div>
			)}

			<div>
				{totalTopLevel === 0 && !activeSessionId && (
					<p className="text-sm text-muted-foreground py-4 text-center">No activity yet</p>
				)}
				{phases.map((phase, index) => {
					const open = isPhaseOpen(index)
					return (
						<Collapsible key={`${phase.status}-${phase.startedAt ?? index}`} asChild open={open}>
							<section>
								<PhaseDivider
									status={phase.status}
									startedAt={phase.startedAt}
									isOpen={open}
									eventCount={phase.events.length}
									onToggle={() => togglePhase(index)}
								/>
								<CollapsibleContent>
									<div className="space-y-1">
										{phase.events.map((event) =>
											event.action === 'commented' ? (
												<ActivityComment
													key={event.id}
													event={event}
													replies={repliesByParent.get(event.id) ?? []}
													workspaceId={workspaceId}
													objectId={object.id}
													mentionSessions={sessionsByComment.get(event.id) ?? []}
													isUnread={unreadEventIds.has(event.id)}
												/>
											) : (
												<ActivityItem
													key={event.id}
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
											),
										)}
									</div>
								</CollapsibleContent>
							</section>
						</Collapsible>
					)
				})}
			</div>

			{/* Sentinel: when this element scrolls into view, advance the read
			    high-water-mark to the latest comment event id. Covers the
			    common case where the user scrolls past the activity list. The
			    "Mark all as read" button above is the explicit fallback. */}
			<div ref={sentinelRef} aria-hidden className="h-0 w-0" />

			<PendingComments objectId={object.id} />

			<div className="mt-4">
				<CommentInput workspaceId={workspaceId} objectId={object.id} />
			</div>
		</div>
	)
}

export function computeUnreadEventIds(
	events: EventResponse[] | undefined,
	unreadCount: number,
): Set<number> {
	if (!events || unreadCount <= 0) return new Set<number>()
	const sorted = events
		.filter((e) => e.action === 'commented')
		.sort((a, b) => b.id - a.id)
		.slice(0, unreadCount)
	return new Set(sorted.map((e) => e.id))
}

function PendingComments({ objectId }: { objectId: string }) {
	const pending = usePendingCommentsForObject(objectId)
	if (pending.length === 0) return null
	return (
		<div className="mt-2 space-y-0.5">
			{pending.map((entry) => (
				<PendingCommentRow key={entry.tempId} entry={entry} />
			))}
		</div>
	)
}
