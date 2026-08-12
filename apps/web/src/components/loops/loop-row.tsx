import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatLoopMedianMs } from '@/lib/loop-duration'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { LOOP_PILL_STYLES } from './loop-pill'

// Plain-language "what happened last" line, derived purely from the loop's live
// state (no fixtures). The read schema carries no per-activity feed, so this
// surfaces the most useful real signal: whether the operator is needed, and how
// much of the loop's work is still moving through it.
function lastActivityText(loop: LoopSummary): string {
	switch (loop.pill) {
		case 'waiting_on_you': {
			const n = loop.humanDecisionPoints
			return n && n > 0
				? `Waiting on you — ${n} decision point${n === 1 ? '' : 's'} open`
				: 'Waiting on you'
		}
		case 'paused':
			return 'Paused — not running'
		case 'archived':
			return 'Archived'
		default:
			if (loop.inProgressCount > 0)
				return `${loop.inProgressCount} item${loop.inProgressCount === 1 ? '' : 's'} in progress`
			if (loop.closedCount > 0)
				return `${loop.closedCount} item${loop.closedCount === 1 ? '' : 's'} completed`
			return 'Running'
	}
}

export function LoopRow({
	loop,
	actors,
}: {
	loop: LoopSummary
	actors: ActorListItem[] | undefined
}) {
	const pill = LOOP_PILL_STYLES[loop.pill]
	const isWaiting = loop.pill === 'waiting_on_you'
	const inProgressColor = isWaiting
		? 'text-warning'
		: loop.pill === 'running'
			? 'text-success'
			: 'text-muted-foreground'
	const median = formatLoopMedianMs(loop.medianTimeToCloseMs)
	const agentCards = loop.agentIds
		.map((id) => actors?.find((a) => a.id === id))
		.filter((a): a is ActorListItem => Boolean(a))
	const lastActor = agentCards[0]
	const activity = lastActivityText(loop)

	return (
		<Link
			to="/$workspaceId/loops/$loopId"
			params={{ workspaceId: loop.workspaceId, loopId: loop.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
		>
			<div className="flex flex-col items-center gap-1">
				<span className={cn('h-3 w-3 rounded-full shrink-0', pill.dot)} />
			</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-sm font-medium text-foreground truncate">
						{loop.name ?? 'Untitled loop'}
					</p>
					<span data-testid="loop-pill" className={cn('text-[10px] font-medium', pill.text)}>
						{pill.label}
					</span>
				</div>
				{loop.guarantee && (
					<p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{loop.guarantee}</p>
				)}
				{(activity || loop.updatedAt) && (
					<div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground min-w-0">
						{lastActor && (
							<ActorAvatar id={lastActor.id} name={lastActor.name} type={lastActor.type} />
						)}
						<span className="truncate">{activity}</span>
						{loop.updatedAt && (
							<>
								<span aria-hidden="true">·</span>
								<RelativeTime date={loop.updatedAt} className="shrink-0" />
							</>
						)}
					</div>
				)}
				{agentCards.length > 0 && (
					<div className="flex items-center gap-1 mt-2">
						{agentCards.slice(0, 5).map((agent) => (
							<ActorAvatar key={agent.id} id={agent.id} name={agent.name} type={agent.type} />
						))}
						{agentCards.length > 5 && (
							<span className="text-[10px] text-muted-foreground ml-1">
								+{agentCards.length - 5}
							</span>
						)}
					</div>
				)}
			</div>
			<div className="flex flex-col items-end gap-0.5 shrink-0 text-right">
				<p className={cn('text-sm font-medium', inProgressColor)}>
					{loop.inProgressCount} in progress
				</p>
				<p className="text-xs text-muted-foreground">
					{loop.closedCount} closed
					{median && <> · {median}</>}
				</p>
			</div>
			<ChevronRight size={15} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
		</Link>
	)
}
