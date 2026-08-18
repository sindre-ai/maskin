import { RelativeTime } from '@/components/shared/relative-time'
import { useActors } from '@/hooks/use-actors'
import { useUpdateObject } from '@/hooks/use-objects'
import type { EventResponse, UpdateObjectInput } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	OBJECT_DIFF_FIELDS,
	type SafeMetadata,
	formatEventDescription,
	getChangesFromEventData,
} from '@maskin/shared'
import { useMemo } from 'react'
import { toast } from 'sonner'

// Changes-log actions — config-only mutations to the loop row itself that a
// human may want to undo. Agent-work actions (session_*, commented, created,
// deleted) belong to the "Latest activity" feed, not this log.
const CHANGE_ACTIONS = new Set(['updated', 'status_changed'])

// Object columns that map 1:1 onto UpdateObjectInput and are safe for a human
// to restore. `activeSessionId` is server-managed and excluded.
const UNDOABLE_FIELDS = ['status', 'title', 'content', 'metadata', 'driver'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build the UpdateObjectInput that reverts the whitelisted fields of a change
 *  event to their recorded pre-update values. Returns null when nothing on the
 *  loop is safe to restore. */
function buildUndoData(event: EventResponse): UpdateObjectInput | null {
	const changes = getChangesFromEventData(event.data, OBJECT_DIFF_FIELDS) ?? []
	const data: UpdateObjectInput = {}
	for (const field of UNDOABLE_FIELDS) {
		const change = changes.find((c) => c.field === field)
		if (!change || change.old === undefined || change.old === '') continue
		if (field === 'metadata') {
			// The update schema has no `null` case for metadata (unlike `driver`),
			// so a change whose pre-update value was unset (`old: null` — the
			// column has no default) can't be restored to null. An empty object
			// is the closest valid equivalent and round-trips through the schema.
			if (isRecord(change.old)) data.metadata = change.old as SafeMetadata
			else if (change.old === null) data.metadata = {}
			continue
		}
		;(data as Record<string, unknown>)[field] = change.old
	}
	return Object.keys(data).length > 0 ? data : null
}

export function LoopChanges({
	workspaceId,
	loopId,
	events,
}: {
	workspaceId: string
	loopId: string
	events: EventResponse[] | undefined
}) {
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, { id: string; name: string; type: string }>()
		for (const actor of actors ?? []) {
			map.set(actor.id, { id: actor.id, name: actor.name, type: actor.type })
		}
		return map
	}, [actors])

	const updateObject = useUpdateObject(workspaceId)

	const rows = useMemo(() => {
		if (!events) return []
		return [...events]
			.filter((event) => event.entityId === loopId && CHANGE_ACTIONS.has(event.action))
			.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
	}, [events, loopId])

	const handleUndo = (event: EventResponse) => {
		const data = buildUndoData(event)
		if (!data) return
		updateObject.mutate(
			{ id: loopId, data },
			{
				onSuccess: () => toast.success('Change undone'),
				onError: () => toast.error('Could not undo that change'),
			},
		)
	}

	if (rows.length === 0) return null

	return (
		<section>
			<header className="flex items-center gap-2.5">
				<h2 className="text-sm font-bold text-foreground">Changes</h2>
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
			</header>

			{/* Chat-bubble register (mockup 1970–1975) — a change to this loop reads
			    as something that was said, not as a table row. */}
			<ul className="flex flex-col gap-2.5 pt-3">
				{rows.map((event) => {
					const actor = actorsById.get(event.actorId)
					const isHuman = actor?.type === 'human'
					return (
						<li key={event.id} className={cn('flex', isHuman ? 'justify-end' : 'justify-start')}>
							<p
								className={cn(
									'max-w-[85%] rounded-2xl border px-3.5 py-2.5 text-[13px] leading-relaxed',
									isHuman
										? 'border-primary bg-primary text-primary-foreground'
										: 'border-border bg-card text-foreground',
								)}
							>
								{actor && <span className="font-semibold">{actor.name} </span>}
								{formatEventDescription(event, { actorsById })}
							</p>
						</li>
					)
				})}
			</ul>

			{/* The applied-change log with per-row undo sits below the bubbles
			    (mockup 1976–1986). */}
			<ul className="flex flex-col gap-1.5 pt-3">
				{rows.map((event) => {
					const undoData = buildUndoData(event)
					if (!undoData) return null
					return (
						<li key={`log-${event.id}`} className="flex items-baseline gap-2.5">
							<span aria-hidden="true" className="shrink-0 text-[11px] text-success">
								✓
							</span>
							<span className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">
								{formatEventDescription(event, { actorsById })}
							</span>
							{event.createdAt && (
								<RelativeTime
									date={event.createdAt}
									className="shrink-0 font-mono text-[10px] text-muted-foreground"
								/>
							)}
							<button
								type="button"
								onClick={() => handleUndo(event)}
								disabled={updateObject.isPending}
								className="shrink-0 text-[11.5px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
							>
								undo
							</button>
						</li>
					)
				})}
			</ul>
		</section>
	)
}
