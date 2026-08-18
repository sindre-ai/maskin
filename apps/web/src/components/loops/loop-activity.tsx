import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { useActors } from '@/hooks/use-actors'
import type { ActorListItem, EventResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatEventDescription } from '@maskin/shared'
import { ChevronDown } from 'lucide-react'
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
		// Plain heading + hairline rule (mockup 1949–1950) — the same register as
		// the sibling Changes section, not a bordered card.
		<section>
			<header className="flex items-center gap-2.5">
				<h2 className="text-sm font-bold text-foreground">Latest activity</h2>
				<span className="text-[11px] text-muted-foreground">what the agents did last</span>
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
			</header>

			{shown.length === 0 ? (
				<p className="pt-3.5 text-sm text-muted-foreground">No activity yet.</p>
			) : (
				<ul className="flex flex-col gap-3.5 pt-3.5">
					{shown.map((event) => {
						const actor = actorsById.get(event.actorId)
						return (
							<li key={event.id} className="flex gap-2.5">
								<ActorAvatar
									id={event.actorId}
									name={actor?.name ?? 'Unknown'}
									type={actor?.type ?? 'agent'}
									className="mt-px shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-baseline gap-2">
										<span className="text-[12.5px] font-bold text-foreground">
											{actor?.name ?? 'Unknown'}
										</span>
										{event.createdAt && (
											<RelativeTime
												date={event.createdAt}
												className="font-mono text-[10px] text-muted-foreground"
											/>
										)}
									</div>
									<p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
										{formatEventDescription(event, { actorsById })}
									</p>
								</div>
							</li>
						)
					})}
				</ul>
			)}

			{rows.length > DEFAULT_LIMIT && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
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
