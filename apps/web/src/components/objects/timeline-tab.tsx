import { ActivityComment } from '@/components/activity/activity-comment'
import { hasDecisionChips } from '@/components/activity/decision-chips'
import { computeUnreadEventIds } from '@/components/activity/object-activity'
import { PhaseDivider } from '@/components/activity/phase-divider'
import {
	type ChipTone,
	TimelineEventRow,
	eventChip,
} from '@/components/activity/timeline-event-row'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useObjectGraph } from '@/hooks/use-objects'
import type { ActorListItem, EventResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { OBJECT_DIFF_FIELDS, findChange, getChangesFromEventData } from '@maskin/shared'
import { formatEventDescription } from '@maskin/shared'
import { ArrowDown, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * One row of the merged activity stream (mockup 1176–1355). Comments and events
 * live in the same chronological spine — the mockup has a single Activity
 * stream, not the Activity/Timeline split this surface used to carry.
 */
type TimelineEntry =
	| {
			kind: 'comment'
			key: string
			time: string | null
			event: EventResponse
	  }
	| {
			kind: 'event'
			key: string
			time: string | null
			actorId: string | null
			text: string
			chipLabel: string
			chipTone: ChipTone
			isStatusChange: boolean
			/** Edge rows read `<when> <verb> <object chip>` with a square node —
			 *  the mockup's `tl.isRel` (1258–1272), not a sentence. */
			isRelationship: boolean
			newStatus: string | null
			reference?: { verb: string; objectId: string; object?: ObjectResponse }
	  }

/** `JUN 8 → 2H` — the span a fold covers, read off its first and last row. */
function foldRange(rows: TimelineEntry[]): string | null {
	const times = rows.map((row) => row.time).filter((t): t is string => !!t)
	if (times.length < 2) return null
	const oldest = times[times.length - 1]
	const newest = times[0]
	if (!oldest || !newest) return null
	const fmt = (value: string) =>
		new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
	return `${fmt(oldest)} → ${fmt(newest)}`
}

/** A collapsed run of low-signal rows (mockup 1205–1219). */
interface TimelineFold {
	kind: 'fold'
	key: string
	rows: TimelineEntry[]
}

type StreamRow = TimelineEntry | TimelineFold

/** A run of this many consecutive low-signal rows collapses behind one pill. */
const FOLD_MIN_RUN = 3

/**
 * Collapse consecutive runs of routine machine chatter — plain updates, session
 * rows, link rows — into a single fold. Comments and status changes are the
 * spine of the story and are never folded, so the unread divider's target and
 * every phase boundary stay reachable.
 */
function foldRuns(entries: TimelineEntry[]): StreamRow[] {
	const out: StreamRow[] = []
	let run: TimelineEntry[] = []
	const flush = () => {
		if (run.length === 0) return
		if (run.length >= FOLD_MIN_RUN) {
			out.push({ kind: 'fold', key: `fold-${run[0]?.key}`, rows: run })
		} else {
			out.push(...run)
		}
		run = []
	}
	for (const entry of entries) {
		if (entry.kind === 'event' && !entry.isStatusChange) run.push(entry)
		else {
			flush()
			out.push(entry)
		}
	}
	flush()
	return out
}

/**
 * Chip-row filters, mockup 1145–1152. `decisions` is the subset of comments
 * that carry a decision — an ask with options, or one already answered; the
 * mockup's `cnt.decisions`. `changes` is everything that is not a comment.
 */
type StreamFilter = 'all' | 'comments' | 'decisions' | 'changes'

const FILTERS: Array<{ id: StreamFilter; label: string }> = [
	{ id: 'all', label: 'All' },
	{ id: 'comments', label: 'Comments' },
	{ id: 'decisions', label: 'Decisions' },
	{ id: 'changes', label: 'Changes' },
]

/**
 * The mockup's `cnt.decisions` — a comment that asked the reader to choose.
 * Carrying decision chips is what makes a comment a decision; a plain comment,
 * however important, is not one.
 */
function isDecisionComment(event: EventResponse): boolean {
	return hasDecisionChips(event)
}

// Past-participle inverses for inbound relationships (matches
// activity/relationship-node.tsx's INBOUND_VERB).
const INBOUND_VERB: Record<string, string> = {
	informs: 'informed by',
	breaks_into: 'part of',
	blocks: 'blocked by',
	relates_to: 'related to',
	duplicates: 'duplicated by',
	attached: 'attached to',
}

function relationshipVerb(type: string, direction: 'outbound' | 'inbound'): string {
	if (direction === 'outbound') return type.replace(/_/g, ' ')
	return INBOUND_VERB[type] ?? `← ${type.replace(/_/g, ' ')}`
}

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight', 'knowledge'])

/**
 * Emit the object reference slot for an event when the row points at a
 * different object than the one this page is about — otherwise the reference
 * card would duplicate the page's own header.
 */
function eventReference(
	event: EventResponse,
	pageObjectId: string,
): { verb: string; objectId: string } | undefined {
	if (!OBJECT_ENTITY_TYPES.has(event.entityType)) return undefined
	if (event.entityId === pageObjectId) return undefined
	const verb = event.action === 'deleted' ? 'from' : 'on'
	return { verb, objectId: event.entityId }
}

function newStatusOf(event: EventResponse): string | null {
	const changes = getChangesFromEventData(event.data, OBJECT_DIFF_FIELDS)
	const value = findChange(changes, 'status')?.new
	return typeof value === 'string' ? value : null
}

export function TimelineTab({ object }: { object: ObjectResponse }) {
	const { workspaceId } = useWorkspace()
	const {
		data: graph,
		isLoading: isGraphLoading,
		isError: isGraphError,
		error: graphError,
	} = useObjectGraph(workspaceId, object.id)
	const events = graph?.events
	const relationships = graph?.relationships
	const connectedObjects = graph?.connected_objects

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

	// Replies are bucketed under their parent comment so threads stay intact
	// inside the single stream.
	const repliesByParent = useMemo(() => {
		const replies = new Map<number, EventResponse[]>()
		for (const event of events ?? []) {
			if (event.action !== 'commented') continue
			const parentId = event.data?.parentEventId as number | undefined
			if (!parentId) continue
			const existing = replies.get(parentId) ?? []
			existing.push(event)
			replies.set(parentId, existing)
		}
		return replies
	}, [events])

	const entries = useMemo(() => {
		const rows: TimelineEntry[] = []

		for (const event of events ?? []) {
			if (event.action === 'commented') {
				// Replies render inside their parent's row, never as their own entry.
				if (event.data?.parentEventId) continue
				rows.push({ kind: 'comment', key: `comment-${event.id}`, time: event.createdAt, event })
				continue
			}

			const chip = eventChip(event)
			const reference = eventReference(event, object.id)
			rows.push({
				kind: 'event',
				key: `event-${event.id}`,
				time: event.createdAt,
				actorId: event.actorId,
				text: formatEventDescription(event, { actorsById }),
				chipLabel: chip.label,
				chipTone: chip.tone,
				isStatusChange: event.action === 'status_changed',
				isRelationship: false,
				newStatus: event.action === 'status_changed' ? newStatusOf(event) : null,
				reference: reference
					? { ...reference, object: objectsById.get(reference.objectId) }
					: undefined,
			})
		}

		for (const rel of relationships ?? []) {
			const direction: 'outbound' | 'inbound' = rel.sourceId === object.id ? 'outbound' : 'inbound'
			const linkedId = direction === 'outbound' ? rel.targetId : rel.sourceId
			const linkedTitle = direction === 'outbound' ? rel.targetTitle : rel.sourceTitle
			rows.push({
				kind: 'event',
				key: `rel-${rel.id}`,
				time: rel.createdAt,
				actorId: rel.createdBy,
				text: 'linked this',
				chipLabel: 'Link',
				chipTone: 'link',
				isStatusChange: false,
				isRelationship: true,
				newStatus: null,
				reference: {
					verb: relationshipVerb(rel.type, direction),
					objectId: linkedId,
					object:
						objectsById.get(linkedId) ??
						(linkedTitle
							? ({
									id: linkedId,
									workspaceId,
									type: direction === 'outbound' ? rel.targetType : rel.sourceType,
									title: linkedTitle,
									content: null,
									status: 'unknown',
									metadata: null,
									driver: null,
									activeSessionId: null,
									createdBy: '',
									createdAt: null,
									updatedAt: null,
								} satisfies ObjectResponse)
							: undefined),
				},
			})
		}

		// Newest first — mirrors both /api/objects/:id/graph's event order and
		// the prototype's descending spine.
		rows.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
		return rows
	}, [events, relationships, actorsById, objectsById, object.id, workspaceId])

	const counts = useMemo(() => {
		let comments = 0
		let decisions = 0
		for (const entry of entries) {
			if (entry.kind !== 'comment') continue
			comments++
			if (isDecisionComment(entry.event)) decisions++
		}
		return { all: entries.length, comments, decisions, changes: entries.length - comments }
	}, [entries])

	const [filter, setFilter] = useState<StreamFilter>('all')
	const visible = useMemo(() => {
		if (filter === 'all') return entries
		return entries.filter((entry) => {
			if (filter === 'comments') return entry.kind === 'comment'
			if (filter === 'decisions') return entry.kind === 'comment' && isDecisionComment(entry.event)
			return entry.kind !== 'comment'
		})
	}, [filter, entries])

	// Unread = the most recent `unread_count` comment events (mirrors the
	// server high-water mark). The NEW divider sits directly above the oldest
	// unread comment in the descending stream.
	const unreadCount = object.unread_count ?? 0
	const unreadEventIds = useMemo(
		() => computeUnreadEventIds(events, unreadCount),
		[events, unreadCount],
	)
	const [unreadDismissed, setUnreadDismissed] = useState(false)
	const firstUnreadId = useMemo(() => {
		if (unreadEventIds.size === 0) return null
		let min: number | null = null
		for (const entry of entries) {
			if (entry.kind !== 'comment') continue
			if (!unreadEventIds.has(entry.event.id)) continue
			if (min === null || entry.event.id < min) min = entry.event.id
		}
		return min
	}, [unreadEventIds, entries])
	const showUnreadDivider = !unreadDismissed && firstUnreadId !== null

	const containerRef = useRef<HTMLDivElement>(null)
	const [jumpTick, setJumpTick] = useState(0)
	useEffect(() => {
		if (jumpTick === 0 || firstUnreadId === null) return
		const el = containerRef.current?.querySelector(`#comment-${firstUnreadId}`)
		el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
	}, [jumpTick, firstUnreadId])

	// Collapsed phases, keyed by the status the phase opened with. Phase rows
	// are chronological groups the mockup shows as labelled dividers (1226–1233).
	const [collapsedPhases, setCollapsedPhases] = useState<ReadonlySet<string>>(new Set())
	const togglePhase = (key: string) => {
		setCollapsedPhases((prev) => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}

	// Walk the descending stream: a status change opens the phase everything
	// above it belongs to, so the divider renders in place, before its rows.
	const phases = useMemo(() => {
		const out: Array<{
			key: string
			status: string
			startedAt: string | null
			rows: TimelineEntry[]
		}> = [
			{ key: `phase-current-${object.status}`, status: object.status, startedAt: null, rows: [] },
		]
		for (const entry of visible) {
			out[out.length - 1]?.rows.push(entry)
			if (entry.kind === 'event' && entry.isStatusChange) {
				// Everything older than this change sat in the status it moved from;
				// the entry itself carries the new status and closes the phase above.
				out.push({
					key: `phase-${entry.key}`,
					status: entry.newStatus ?? object.status,
					startedAt: entry.time,
					rows: [],
				})
			}
		}
		return out.filter((phase) => phase.rows.length > 0)
	}, [visible, object.status])

	const showPhases = filter === 'all' && phases.length > 1

	// Expanded folds, keyed by the fold's first row. Transient — a fold is a
	// reading affordance, not view state worth persisting.
	const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(new Set())
	const toggleFold = (key: string) => {
		setExpandedFolds((prev) => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}

	const renderEntry = (entry: TimelineEntry) => {
		const divider =
			showUnreadDivider && entry.kind === 'comment' && entry.event.id === firstUnreadId ? (
				<UnreadDivider count={unreadCount} onMarkRead={() => setUnreadDismissed(true)} />
			) : null
		return (
			<li key={entry.key} className="list-none">
				{divider}
				{entry.kind === 'comment' ? (
					<ActivityComment
						event={entry.event}
						replies={repliesByParent.get(entry.event.id) ?? []}
						workspaceId={workspaceId}
						objectId={object.id}
						isUnread={unreadEventIds.has(entry.event.id)}
						variant="bubble"
						collapsibleReplies
					/>
				) : (
					<EventRow entry={entry} actorsById={actorsById} workspaceId={workspaceId} />
				)}
			</li>
		)
	}

	const renderRow = (row: StreamRow) => {
		if (row.kind !== 'fold') return renderEntry(row)
		const open = expandedFolds.has(row.key)
		return (
			<li key={row.key} className="list-none">
				<div className="relative py-1 pl-9">
					<span
						aria-hidden="true"
						className="absolute left-[11px] top-3 size-[7px] rounded-full bg-border"
					/>
					<button
						type="button"
						aria-expanded={open}
						onClick={() => toggleFold(row.key)}
						className="inline-flex h-[26px] items-center gap-2 rounded-full border border-dashed border-border px-3 transition-colors hover:border-border-strong hover:bg-muted/40"
					>
						<span className="text-[11.5px] font-semibold text-muted-foreground">
							{open ? `Hide ${row.rows.length} updates` : `${row.rows.length} agent updates`}
						</span>
						{/* The span the fold covers, oldest → newest (mockup 1211). */}
						{!open && foldRange(row.rows) && (
							<span className="text-[10px] text-border-strong">{foldRange(row.rows)}</span>
						)}
						<ChevronDown
							size={10}
							aria-hidden="true"
							className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}
						/>
					</button>
				</div>
				{open && <ol className="m-0 list-none p-0">{row.rows.map(renderEntry)}</ol>}
			</li>
		)
	}

	// Loading → error → empty. "No activity yet." is a claim about the object,
	// so it may only be made once the graph has resolved — a pending or failed
	// fetch has the same empty `events` array and must not read as one.
	if (isGraphLoading) {
		return (
			<div className="w-full min-w-0 pt-2.5">
				<ListSkeleton rows={3} />
			</div>
		)
	}

	if (isGraphError) {
		return (
			<div className="w-full min-w-0 pt-2.5">
				<QueryStateError title="Couldn't load activity" error={graphError} />
			</div>
		)
	}

	return (
		<div className="w-full min-w-0">
			<div className="flex flex-wrap items-center gap-1.5 pb-2 pt-2.5">
				{FILTERS.map((f) => {
					const active = filter === f.id
					return (
						<button
							key={f.id}
							type="button"
							aria-pressed={active}
							aria-label={`${f.label} (${counts[f.id]})`}
							onClick={() => setFilter(f.id)}
							className={cn(
								'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border px-[11px] text-[11.5px] font-semibold transition-colors',
								active
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:border-border-hover hover:text-foreground',
							)}
						>
							{f.label}
							<span
								aria-hidden="true"
								className={cn(
									'text-[10.5px] font-semibold tabular-nums',
									active ? 'text-primary-foreground/50' : 'text-border-strong',
								)}
							>
								{counts[f.id]}
							</span>
						</button>
					)
				})}
				{firstUnreadId !== null && (
					<button
						type="button"
						onClick={() => {
							setFilter('all')
							setJumpTick((t) => t + 1)
						}}
						className="ml-auto inline-flex h-[26px] items-center gap-1.5 rounded-full bg-brand-subtle px-[11px] text-[11.5px] font-bold text-brand-subtle-foreground transition-colors hover:bg-brand/20"
					>
						{unreadCount} {unreadCount === 1 ? 'new update' : 'new updates'}
						<ArrowDown size={12} aria-hidden="true" />
					</button>
				)}
			</div>

			{visible.length === 0 ? (
				<div className="flex flex-col items-center gap-2.5 px-3 py-8 text-center">
					<p className="text-[12.5px] text-muted-foreground">
						{filter === 'all' ? 'No activity yet.' : 'Nothing in this view yet.'}
					</p>
					{filter !== 'all' && (
						<Button variant="outline" size="sm" onClick={() => setFilter('all')}>
							Show all activity
						</Button>
					)}
				</div>
			) : (
				<div ref={containerRef} className="relative pt-2">
					<span aria-hidden="true" className="absolute bottom-3 left-[14px] top-3 w-0.5 bg-muted" />
					{showPhases ? (
						phases.map((phase) => {
							const collapsed = collapsedPhases.has(phase.key)
							return (
								<div key={phase.key}>
									<PhaseDivider
										status={phase.status}
										startedAt={phase.startedAt}
										isOpen={!collapsed}
										onToggle={() => togglePhase(phase.key)}
									/>
									{!collapsed && (
										<ol className="m-0 list-none p-0">{foldRuns(phase.rows).map(renderRow)}</ol>
									)}
								</div>
							)
						})
					) : (
						<ol className="m-0 list-none p-0">{foldRuns(visible).map(renderRow)}</ol>
					)}
				</div>
			)}
		</div>
	)
}

function UnreadDivider({ count, onMarkRead }: { count: number; onMarkRead: () => void }) {
	return (
		<div className="relative z-[3] flex items-center gap-2.5 py-3">
			<span aria-hidden="true" className="h-px flex-1 bg-brand/40" />
			<span className="rounded-full bg-brand/10 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.11em] text-brand">
				{count} new
			</span>
			<button
				type="button"
				onClick={onMarkRead}
				className="text-[10.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
			>
				Mark read
			</button>
			<span aria-hidden="true" className="h-px w-3 bg-brand/40" />
		</div>
	)
}

function EventRow({
	entry,
	actorsById,
	workspaceId,
}: {
	entry: Extract<TimelineEntry, { kind: 'event' }>
	actorsById: Map<string, ActorListItem>
	workspaceId: string
}) {
	const actor = entry.actorId ? actorsById.get(entry.actorId) : undefined
	return (
		<TimelineEventRow
			time={entry.time}
			actorName={actor?.name ?? 'Someone'}
			text={entry.text}
			tone={entry.chipTone}
			workspaceId={workspaceId}
			isRelationship={entry.isRelationship}
			statusLabel={entry.isStatusChange ? entry.newStatus : null}
			reference={entry.reference}
		/>
	)
}
