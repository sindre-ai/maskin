import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { LOOP_PILL_STYLES, isLoopLive } from './loop-pill'

/** How many cycles are moving through the loop right now, in the mockup's own
 *  phrasing (`l.stage`). A loop with nothing in flight says what it has done
 *  instead of printing a zero. */
export function loopStageText(loop: LoopSummary): string {
	if (loop.inProgressCount > 0) return `${loop.inProgressCount} in progress`
	if (loop.closedCount > 0) return `${loop.closedCount} closed`
	return 'Nothing in flight'
}

/** `l.stageColor` — the count carries the loop's own urgency: amber when it is
 *  waiting on the operator, green while it is running on its own. */
function stageColor(loop: LoopSummary): string {
	if (loop.pill === 'waiting_on_you') return 'text-warning'
	if (isLoopLive(loop.pill) && loop.inProgressCount > 0) return 'text-success'
	return 'text-muted-foreground'
}

export function LoopRow({
	loop,
	actors,
	busyAgentIds,
}: {
	loop: LoopSummary
	actors: ActorListItem[] | undefined
	/** Agents of this loop with a live session right now — the small overlapped
	 *  "Working now" stack that sits ahead of the count (mockup `l.busyAvs`). */
	busyAgentIds?: ReadonlySet<string>
}) {
	const pill = LOOP_PILL_STYLES[loop.pill]
	const agents = loop.agentIds
		.map((id) => actors?.find((a) => a.id === id))
		.filter((a): a is ActorListItem => Boolean(a))
	const busy = busyAgentIds ? agents.filter((a) => busyAgentIds.has(a.id)) : []

	return (
		<Link
			to="/$workspaceId/loops/$loopId"
			params={{ workspaceId: loop.workspaceId, loopId: loop.id }}
			className="group flex items-center gap-3 rounded-[10px] border-b border-border px-3 py-[7px] transition-colors duration-150 hover:bg-muted"
		>
			<span className="min-w-0 flex-1 leading-[1.3]">
				<span className="block truncate text-[13px] font-bold tracking-[-0.01em] text-foreground">
					{loop.name ?? 'Untitled loop'}
				</span>
				{loop.content && (
					<span className="mt-px block truncate text-[11.5px] text-muted-foreground">
						{loop.content}
					</span>
				)}
			</span>

			<span className="flex shrink-0 items-center gap-2.5">
				{busy.length > 0 && (
					<span className="flex" title="Working now">
						{busy.slice(0, 3).map((agent) => (
							<ActorAvatar
								key={agent.id}
								id={agent.id}
								name={agent.name}
								type={agent.type}
								className="-ml-1.5 size-[18px] text-[7.5px] ring-[1.5px] ring-card first:ml-0"
							/>
						))}
					</span>
				)}
				<span
					data-testid="loop-stage"
					className={cn('text-[11.5px] font-semibold', stageColor(loop))}
				>
					{loopStageText(loop)}
				</span>
				<span data-testid="loop-pill" className="inline-flex items-center gap-1.5">
					<span
						aria-hidden="true"
						className={cn(
							'size-1.5 shrink-0 rounded-full',
							pill.dot,
							isLoopLive(loop.pill) && 'animate-pulse motion-reduce:animate-none',
						)}
					/>
					<span className="text-[10.5px] font-semibold text-muted-foreground">{pill.label}</span>
				</span>
			</span>

			{agents.length > 0 && (
				<span className="hidden shrink-0 pl-1.5 md:flex">
					{agents.slice(0, 5).map((agent) => (
						<ActorAvatar
							key={agent.id}
							id={agent.id}
							name={agent.name}
							type={agent.type}
							className="-ml-1.5 size-[22px] text-[8.5px] ring-2 ring-card first:ml-0"
						/>
					))}
					{agents.length > 5 && (
						<span className="ml-1 self-center text-[10px] text-muted-foreground">
							+{agents.length - 5}
						</span>
					)}
				</span>
			)}
		</Link>
	)
}
