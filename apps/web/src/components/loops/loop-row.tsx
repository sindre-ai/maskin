import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
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
	busyAgentCount = 0,
}: {
	loop: LoopSummary
	actors: ActorListItem[] | undefined
	/** How many of this loop's agents have a live session right now — drives the
	 *  green "busy" line under the stage label (mockup 1536). */
	busyAgentCount?: number
}) {
	const pill = LOOP_PILL_STYLES[loop.pill]
	const agentCards = loop.agentIds
		.map((id) => actors?.find((a) => a.id === id))
		.filter((a): a is ActorListItem => Boolean(a))
	const lastActor = agentCards[0]
	const activity = lastActivityText(loop)

	return (
		<Link
			to="/$workspaceId/loops/$loopId"
			params={{ workspaceId: loop.workspaceId, loopId: loop.id }}
			className="group flex items-center gap-3.5 rounded-xl border-b border-border px-3.5 py-4 transition-colors duration-150 hover:bg-muted"
		>
			<span
				title={pill.label}
				className={cn(
					'mx-1 h-2 w-2 shrink-0 rounded-full',
					pill.dot,
					loop.pill === 'running' && 'animate-pulse',
				)}
			/>
			<div className="min-w-0 flex-1 leading-[1.35]">
				<p className="truncate text-sm font-bold tracking-[-0.01em] text-foreground">
					{loop.name ?? 'Untitled loop'}
				</p>
				{loop.guarantee && (
					<p className="mt-0.5 truncate text-xs text-muted-foreground">{loop.guarantee}</p>
				)}
				{(activity || loop.updatedAt) && (
					<div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
						{lastActor && (
							<ActorAvatar id={lastActor.id} name={lastActor.name} type={lastActor.type} />
						)}
						{loop.updatedAt && (
							<RelativeTime
								date={loop.updatedAt}
								className="shrink-0 font-mono text-[10px] tracking-[0.04em]"
							/>
						)}
						<span className="truncate">{activity}</span>
					</div>
				)}
			</div>
			<div className="shrink-0 text-right leading-[1.35]">
				<p data-testid="loop-pill" className={cn('text-xs font-semibold', pill.text)}>
					{pill.label}
				</p>
				{busyAgentCount > 0 && (
					<p className="mt-0.5 whitespace-nowrap text-[11px] text-success">
						{busyAgentCount} busy now
					</p>
				)}
			</div>
			{agentCards.length > 0 && (
				<div className="hidden shrink-0 pl-2 md:flex">
					{agentCards.slice(0, 5).map((agent) => (
						<ActorAvatar
							key={agent.id}
							id={agent.id}
							name={agent.name}
							type={agent.type}
							className="-ml-1.5 ring-2 ring-card first:ml-0"
						/>
					))}
					{agentCards.length > 5 && (
						<span className="ml-1 self-center text-[10px] text-muted-foreground">
							+{agentCards.length - 5}
						</span>
					)}
				</div>
			)}
		</Link>
	)
}
