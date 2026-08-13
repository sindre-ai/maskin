import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { useActors } from '@/hooks/use-actors'
import type { ActorListItem, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatEventDescription } from '@maskin/shared'
import { Activity, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

const DEFAULT_LIMIT = 6

// Event actions that represent the loop's agents doing work — the signal
// behind "what the agents did last". Loop-row config actions (updated /
// status_changed / created / commented / deleted) are the Changes-log feed and
// live outside this set on purpose; including them would duplicate that log.
// The endpoint at /api/loops/:id/activity is already scoped to session/trigger
// events, so this set is a defensive filter, not the primary gate.
const AGENT_ACTIONS = new Set([
	'session_created',
	'session_running',
	'session_completed',
	'session_failed',
	'session_timeout',
	'session_paused',
	'trigger_fired',
])

export function LoopActivity({
	workspaceId,
	events,
}: {
	workspaceId: string
	events: EventResponse[] | undefined
}) {
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	const rows = useMemo(() => {
		if (!events) return []
		return [...events]
			.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
			.filter((event) => AGENT_ACTIONS.has(event.action))
	}, [events])

	const [expanded, setExpanded] = useState(false)
	const shown = expanded ? rows : rows.slice(0, DEFAULT_LIMIT)

	return (
		<section className="rounded-xl border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-4 py-3">
				<Activity size={14} className="text-muted-foreground" aria-hidden="true" />
				<h2 className="text-sm font-semibold text-foreground">Latest activity</h2>
				<span className="text-xs text-muted-foreground">what the agents did last</span>
			</div>

			{shown.length === 0 ? (
				<p className="px-4 py-4 text-sm text-muted-foreground">No activity yet.</p>
			) : (
				<ul className="divide-y divide-border">
					{shown.map((event) => {
						const actor = actorsById.get(event.actorId)
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
							</li>
						)
					})}
				</ul>
			)}

			{rows.length > DEFAULT_LIMIT && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="flex w-full items-center justify-center gap-1 border-t border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
				>
					<ChevronDown
						size={13}
						className={cn('transition-transform', expanded && 'rotate-180')}
						aria-hidden="true"
					/>
					{expanded ? 'Show less' : 'See all activity'}
				</button>
			)}
		</section>
	)
}
