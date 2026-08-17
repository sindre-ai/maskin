import { EmptyState } from '@/components/shared/empty-state'
import { ObjectReference } from '@/components/shared/object-reference'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { useActors } from '@/hooks/use-actors'
import { useObjectGraph } from '@/hooks/use-objects'
import type { ActorListItem, EventResponse, ObjectResponse, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { formatEventDescription } from '@maskin/shared'
import { useMemo } from 'react'

/**
 * Timeline entry mapped from either an event row or a relationship row. Both
 * carry the same five slots the bet's acceptance criterion names: time, who,
 * text, chip, and an optional object reference with a verb.
 */
type TimelineEntry = {
	key: string
	time: string | null
	actorId: string | null
	text: string
	chipLabel: string
	chipTone: 'status' | 'session' | 'link' | 'update' | 'created' | 'signal'
	dotTone: 'status' | 'session' | 'link' | 'update' | 'created' | 'signal'
	reference?: {
		verb: string
		objectId: string
		object?: ObjectResponse
	}
}

// Past-participle inverses for inbound relationships (matches
// activity/relationship-node.tsx's INBOUND_VERB — kept local to keep the tab
// self-contained per the brief).
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

const CHIP_TONE_CLASSES: Record<TimelineEntry['chipTone'], string> = {
	status: 'border-transparent bg-secondary text-foreground',
	session: 'border-transparent bg-secondary text-foreground',
	link: 'border-border bg-background text-muted-foreground',
	update: 'border-border bg-background text-muted-foreground',
	created: 'border-border bg-background text-muted-foreground',
	signal: 'border-transparent bg-destructive/10 text-destructive',
}

const DOT_TONE_CLASSES: Record<TimelineEntry['dotTone'], string> = {
	status: 'bg-foreground',
	session: 'bg-primary',
	link: 'bg-muted-foreground',
	update: 'bg-muted-foreground',
	created: 'bg-muted-foreground',
	signal: 'bg-destructive',
}

function eventChip(event: EventResponse): {
	label: string
	tone: TimelineEntry['chipTone']
} {
	const { action } = event
	if (action === 'status_changed') return { label: 'Status', tone: 'status' }
	if (action.startsWith('session_')) {
		const failed = action === 'session_failed' || action === 'session_timeout'
		return { label: 'Session', tone: failed ? 'signal' : 'session' }
	}
	if (action === 'trigger_fired') return { label: 'Trigger', tone: 'session' }
	if (action === 'created') return { label: 'Created', tone: 'created' }
	if (action === 'deleted') return { label: 'Deleted', tone: 'signal' }
	if (action === 'verified' || action === 'unverified') {
		return { label: 'Verified', tone: 'update' }
	}
	return { label: 'Update', tone: 'update' }
}

/**
 * Emit the object reference slot for an event when the row points at a
 * different object than the one this page is about — otherwise the reference
 * card would duplicate the page's own header.
 */
function eventReference(
	event: EventResponse,
	pageObjectId: string,
): TimelineEntry['reference'] | undefined {
	if (!OBJECT_ENTITY_TYPES.has(event.entityType)) return undefined
	if (event.entityId === pageObjectId) return undefined
	const verb =
		event.action === 'created'
			? 'on'
			: event.action === 'deleted'
				? 'from'
				: event.action === 'status_changed'
					? 'on'
					: 'on'
	return { verb, objectId: event.entityId }
}

export function TimelineTab({ object }: { object: ObjectResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: graph } = useObjectGraph(workspaceId, object.id)
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

	const entries = useMemo(() => {
		const rows: TimelineEntry[] = []

		for (const event of events ?? []) {
			// Comments and their replies live in the Activity tab (per the brief's
			// out-of-scope note); Timeline holds status changes, session events,
			// relationship creations, and object updates.
			if (event.action === 'commented') continue

			const chip = eventChip(event)
			const text = formatEventDescription(event, { actorsById })
			const reference = eventReference(event, object.id)
			const withObject = reference
				? { ...reference, object: objectsById.get(reference.objectId) }
				: undefined

			rows.push({
				key: `event-${event.id}`,
				time: event.createdAt,
				actorId: event.actorId,
				text,
				chipLabel: chip.label,
				chipTone: chip.tone,
				dotTone: chip.tone,
				reference: withObject,
			})
		}

		for (const rel of relationships ?? []) {
			const direction: 'outbound' | 'inbound' = rel.sourceId === object.id ? 'outbound' : 'inbound'
			const linkedId = direction === 'outbound' ? rel.targetId : rel.sourceId
			const linkedTitle = direction === 'outbound' ? rel.targetTitle : rel.sourceTitle
			const verb = relationshipVerb(rel.type, direction)
			rows.push({
				key: `rel-${rel.id}`,
				time: rel.createdAt,
				actorId: rel.createdBy,
				text: 'linked this',
				chipLabel: 'Link',
				chipTone: 'link',
				dotTone: 'link',
				reference: {
					verb,
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

	return (
		<div className="w-full min-w-0">
			<div className="mb-3 flex items-center justify-between gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Timeline
				</h3>
				<span className="text-xs tabular-nums text-muted-foreground">{entries.length}</span>
			</div>

			{entries.length === 0 ? (
				<EmptyState
					title="No timeline entries yet"
					description="Status changes, links, and session events will appear here."
				/>
			) : (
				<ol className="relative m-0 list-none space-y-2 p-0">
					<span aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
					{entries.map((entry) => {
						const actor = entry.actorId ? actorsById.get(entry.actorId) : undefined
						const who = actor?.name ?? 'Someone'
						return (
							<li key={entry.key} className="relative pl-6">
								<span
									aria-hidden
									className={cn(
										'absolute left-0 top-[7px] h-3.5 w-3.5 rounded-full border-2 border-background',
										DOT_TONE_CLASSES[entry.dotTone],
									)}
								/>
								<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
									{entry.time && (
										<RelativeTime
											date={entry.time}
											className="w-14 shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
										/>
									)}
									<span className="font-medium text-foreground">{who}</span>
									<span className="min-w-0 text-muted-foreground">{entry.text}</span>
									<Badge
										variant="outline"
										className={cn(
											'shrink-0 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide',
											CHIP_TONE_CLASSES[entry.chipTone],
										)}
									>
										{entry.chipLabel}
									</Badge>
									{entry.reference && (
										<span className="flex min-w-0 items-baseline gap-1.5">
											<span className="shrink-0 text-xs text-muted-foreground">
												{entry.reference.verb}
											</span>
											<ObjectReference
												objectId={entry.reference.objectId}
												workspaceId={workspaceId}
												object={entry.reference.object}
												variant="inline"
												className="min-w-0 text-sm"
											/>
										</span>
									)}
								</div>
							</li>
						)
					})}
				</ol>
			)}
		</div>
	)
}
