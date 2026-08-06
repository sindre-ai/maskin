import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatLoopMedianMs } from '@/lib/loop-duration'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { LOOP_PILL_STYLES } from './loop-pill'

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
					<span className={cn('text-[10px] font-medium', pill.text)}>{pill.label}</span>
				</div>
				{loop.guarantee && (
					<p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{loop.guarantee}</p>
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
