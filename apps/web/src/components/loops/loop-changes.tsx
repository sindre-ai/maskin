import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { useActors } from '@/hooks/use-actors'
import { useUpdateObject } from '@/hooks/use-objects'
import type { EventResponse, UpdateObjectInput } from '@/lib/api'
import {
	OBJECT_DIFF_FIELDS,
	type SafeMetadata,
	formatEventDescription,
	getChangesFromEventData,
} from '@maskin/shared'
import { History, Undo2 } from 'lucide-react'
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

	return (
		<section className="rounded-xl border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-4 py-3">
				<History size={14} className="text-muted-foreground" aria-hidden="true" />
				<h2 className="text-sm font-semibold text-foreground">Changes</h2>
				<span className="text-xs text-muted-foreground">recent changes to this loop</span>
			</div>

			{rows.length === 0 ? (
				<p className="px-4 py-4 text-sm text-muted-foreground">No changes yet.</p>
			) : (
				<ul className="divide-y divide-border">
					{rows.map((event) => {
						const actor = actorsById.get(event.actorId)
						const undoData = buildUndoData(event)
						return (
							<li key={event.id} className="flex items-center gap-2.5 px-4 py-2.5">
								<ActorAvatar
									id={event.actorId}
									name={actor?.name ?? 'Unknown'}
									type={actor?.type ?? 'agent'}
									className="shrink-0"
								/>
								<p className="flex-1 min-w-0 truncate text-[12.5px] text-foreground">
									{actor && <span className="font-semibold">{actor.name} </span>}
									<span className="text-muted-foreground">
										{formatEventDescription(event, { actorsById })}
									</span>
								</p>
								{event.createdAt && (
									<RelativeTime
										date={event.createdAt}
										className="shrink-0 text-xs text-muted-foreground"
									/>
								)}
								{undoData && (
									<button
										type="button"
										onClick={() => handleUndo(event)}
										disabled={updateObject.isPending}
										className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-bg-hover disabled:opacity-50"
									>
										<Undo2 size={13} aria-hidden="true" />
										Undo
									</button>
								)}
							</li>
						)
					})}
				</ul>
			)}
		</section>
	)
}
