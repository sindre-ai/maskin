import { useActors } from '@/hooks/use-actors'
import { useEventVisible } from '@/hooks/use-event-visible'
import { useMentionSessionsForObject } from '@/hooks/use-sessions'
import { useMarkRead } from '@/hooks/use-subscriptions'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import type {
	ActorListItem,
	EventResponse,
	ObjectResponse,
	RelationshipResponse,
	SessionResponse,
} from '@/lib/api'
import { cn } from '@/lib/cn'
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
import { RelationshipNode } from './relationship-node'
import { RelationshipsTable } from './relationships-table'

export type TimelineView = 'timeline' | 'table'
const DEFAULT_TIMELINE_VIEW: TimelineView = 'timeline'

interface ObjectActivityProps {
	workspaceId: string
	object: ObjectResponse
	events?: EventResponse[]
	relationships?: RelationshipResponse[]
	connectedObjects?: ObjectResponse[]
	onDeleteRelationship?: (relationshipId: string) => void
	activeSessionId?: string | null
}

/**
 * A union node for the activity stream: either a real event row (comment,
 * status_changed, etc.) or a relationship row projected at its `created_at`.
 * Phases are still keyed off `status_changed` events; relationships flow
 * into whichever phase's time window they belong to.
 */
type EventNode = { kind: 'event'; event: EventResponse }
type RelationshipNodeItem = {
	kind: 'relationship'
	rel: RelationshipResponse
	timestamp: string
}
type StreamNode = EventNode | RelationshipNodeItem

function nodeTimestamp(node: StreamNode): string {
	return node.kind === 'event' ? (node.event.createdAt ?? '') : node.timestamp
}

export function ObjectActivity({
	workspaceId,
	object,
	events,
	relationships,
	connectedObjects,
	onDeleteRelationship,
	activeSessionId,
}: ObjectActivityProps) {
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	const objectsById = useMemo(() => {
		const map = new Map<string, ObjectResponse>()
		for (const obj of connectedObjects ?? []) map.set(obj.id, obj)
		return map
	}, [connectedObjects])

	// Persisted Timeline ↔ Table choice — keyed per-actor by object_type
	// (e.g. 'bet'), so the choice survives a different browser. Falls back to
	// 'timeline' until the row loads.
	const { data: displaySettings } = useUserDisplaySettings(workspaceId, object.type)
	const updateDisplaySettings = useUpdateUserDisplaySettings(workspaceId)
	const view: TimelineView =
		(displaySettings?.settings?.timelineView as TimelineView | undefined) ?? DEFAULT_TIMELINE_VIEW

	const handleViewChange = useCallback(
		(next: TimelineView) => {
			if (next === view) return
			const prevSettings = (displaySettings?.settings ?? {}) as Record<string, unknown>
			updateDisplaySettings.mutate({
				objectType: object.type,
				settings: { ...prevSettings, timelineView: next },
			})
		},
		[displaySettings, object.type, updateDisplaySettings, view],
	)

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
	// In Timeline view, relationships are interleaved by their `created_at` (AC-T6).
	// In Table view, the phase walker runs on events only and relationships are
	// rendered separately as a grouped table above the timeline.
	const includeRelationshipsInTimeline = view === 'timeline'
	const { phases, repliesByParent, totalTopLevel } = useMemo(() => {
		if (!events) {
			return {
				phases: [] as Array<{
					status: string
					startedAt: string | null
					nodes: StreamNode[]
				}>,
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

		const rawPhases = buildPhases(topLevel, object)
		const incomingRels = includeRelationshipsInTimeline && relationships ? relationships : []

		// Bucket relationships against the *raw* (unfiltered) phases by
		// `rel.created_at`. If we filtered empty phases first and then bucketed,
		// a rel created during an empty non-terminal phase would index into the
		// surviving phases and silently land in the wrong one.
		const relsByRawIdx = new Map<number, RelationshipResponse[]>()
		const seenRels = new Set<string>()
		for (const rel of incomingRels) {
			if (seenRels.has(rel.id)) continue
			seenRels.add(rel.id)
			if (!rel.createdAt) continue
			// Phases are ordered by startedAt asc; assign to the last phase whose
			// startedAt is ≤ rel.createdAt, falling back to the first phase when
			// nothing matches (relationships created before the first
			// status_changed event).
			let targetRawIdx = -1
			for (let i = 0; i < rawPhases.length; i++) {
				const startedAt = rawPhases[i].startedAt
				if (!startedAt) {
					if (targetRawIdx === -1) targetRawIdx = i
					continue
				}
				if (rel.createdAt >= startedAt) targetRawIdx = i
			}
			if (targetRawIdx === -1 && rawPhases.length > 0) targetRawIdx = 0
			if (targetRawIdx === -1) continue
			const list = relsByRawIdx.get(targetRawIdx) ?? []
			list.push(rel)
			relsByRawIdx.set(targetRawIdx, list)
		}

		// Keep a raw phase if it hosts any events or any bucketed relationships.
		// Special case: when there are incoming relationships but none bucketed
		// into a kept phase (e.g. all rels lack createdAt), keep the terminal
		// phase as a fallback host so the projection still has somewhere to land.
		const phaseHasContent = (idx: number) =>
			rawPhases[idx].events.length > 0 || (relsByRawIdx.get(idx)?.length ?? 0) > 0
		const anyKept = rawPhases.some((_, idx) => phaseHasContent(idx))
		const keepTerminalFallback = incomingRels.length > 0 && !anyKept && rawPhases.length > 0

		const phaseNodes = rawPhases
			.map((phase, rawIdx) => ({ phase, rawIdx }))
			.filter(
				({ rawIdx }) =>
					phaseHasContent(rawIdx) || (keepTerminalFallback && rawIdx === rawPhases.length - 1),
			)
			.map(({ phase, rawIdx }) => {
				const nodes: StreamNode[] = phase.events.map((event) => ({ kind: 'event', event }))
				for (const rel of relsByRawIdx.get(rawIdx) ?? []) {
					nodes.push({ kind: 'relationship', rel, timestamp: rel.createdAt ?? '' })
				}
				nodes.sort((a, b) => nodeTimestamp(a).localeCompare(nodeTimestamp(b)))
				return { status: phase.status, startedAt: phase.startedAt, nodes }
			})

		return {
			phases: phaseNodes,
			repliesByParent: replies,
			totalTopLevel: topLevel.length,
		}
	}, [events, object, relationships, includeRelationshipsInTimeline])

	// All phases are expanded by default; users can toggle any phase closed.
	// Keyed by phase identity (status + startedAt) — not by array index — so
	// the collapsed state stays pinned to the specific phase the user closed
	// when the phases array reshapes (e.g. Timeline↔Table toggle drops
	// relationship-only phases out of the Timeline projection, which would
	// otherwise slide index-based overrides onto the wrong surviving phase
	// and leave the section looking blank until refresh).
	const phaseKey = (phase: { status: string; startedAt: string | null }) =>
		`${phase.status}::${phase.startedAt ?? ''}`
	const [phaseOverrides, setPhaseOverrides] = useState<Record<string, boolean>>({})
	const isPhaseOpen = (phase: { status: string; startedAt: string | null }) =>
		phaseOverrides[phaseKey(phase)] ?? true
	const togglePhase = (phase: { status: string; startedAt: string | null }) => {
		const key = phaseKey(phase)
		setPhaseOverrides((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }))
	}

	const tableViewRelationships = relationships ?? []

	return (
		<div className="border-t border-border pt-6">
			<div className="flex items-center justify-between mb-3 gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Activity
					<UnreadBadge count={unreadCount} className="ml-2 normal-case tracking-normal" />
				</h3>
				<div className="flex items-center gap-2">
					{relationships && <TimelineViewToggle value={view} onChange={handleViewChange} />}
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
			</div>

			{activeSessionId && (
				<div className="mb-3">
					<StreamingIndicator sessionId={activeSessionId} workspaceId={workspaceId} />
				</div>
			)}

			{view === 'table' && relationships && (
				<div className="mb-6">
					<RelationshipsTable
						objectId={object.id}
						relationships={tableViewRelationships}
						objectsById={objectsById}
						workspaceId={workspaceId}
						onDelete={onDeleteRelationship}
					/>
				</div>
			)}

			<div>
				{totalTopLevel === 0 &&
					!activeSessionId &&
					phases.every((phase) => phase.nodes.length === 0) && (
						<p className="text-sm text-muted-foreground py-4 text-center">No activity yet</p>
					)}
				{phases.map((phase, index) => {
					const open = isPhaseOpen(phase)
					return (
						<Collapsible key={`${phase.status}-${phase.startedAt ?? index}`} asChild open={open}>
							<section>
								<PhaseDivider
									status={phase.status}
									startedAt={phase.startedAt}
									isOpen={open}
									onToggle={() => togglePhase(phase)}
								/>
								<CollapsibleContent>
									<div className="space-y-1">
										{phase.nodes.map((node) => {
											if (node.kind === 'relationship') {
												const linkedId =
													node.rel.sourceId === object.id ? node.rel.targetId : node.rel.sourceId
												return (
													<RelationshipNode
														key={`rel-${node.rel.id}`}
														rel={node.rel}
														linked={objectsById.get(linkedId) ?? null}
														workspaceId={workspaceId}
														direction={node.rel.sourceId === object.id ? 'outbound' : 'inbound'}
														onDelete={onDeleteRelationship}
													/>
												)
											}
											const event = node.event
											return event.action === 'commented' ? (
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
											)
										})}
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

function TimelineViewToggle({
	value,
	onChange,
}: {
	value: TimelineView
	onChange: (next: TimelineView) => void
}) {
	return (
		<fieldset className="inline-flex items-center rounded-md border border-border bg-background p-0.5 m-0">
			<legend className="sr-only">Relationship view</legend>
			{(['timeline', 'table'] as const).map((option) => {
				const active = value === option
				return (
					<label
						key={option}
						className={cn(
							'h-6 px-2 text-[11px] font-medium rounded-sm transition-colors capitalize cursor-pointer inline-flex items-center',
							active
								? 'bg-secondary text-foreground'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						<input
							type="radio"
							name="timeline-view"
							value={option}
							checked={active}
							onChange={() => onChange(option)}
							className="sr-only"
						/>
						{option}
					</label>
				)
			})}
		</fieldset>
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
