import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ActorListItem, LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { LOOP_PILL_STYLES, UPGRADE_PILL, isLiveLoopPill } from './loop-pill'
import { paceVerdict } from './target-card'

// Plain-language "what happened last" line, derived purely from the loop's live
// state (no fixtures). The read schema carries no per-activity feed, so this
// surfaces the most useful real signal: whether the operator is needed, and how
// much of the loop's work is still moving through it. Null for a live loop with
// nothing in progress or completed. The chat card for a linked loop reads the
// same line, so the two cannot drift.
export function loopActivityLine(loop: LoopSummary): string | null {
	switch (loop.pill) {
		case 'waiting_on_you':
			return 'Waiting on you'
		case 'paused':
			return 'Paused — not running'
		case 'draft':
			return 'Draft — not live yet'
		default:
			if (loop.inProgressCount > 0)
				return `${loop.inProgressCount} item${loop.inProgressCount === 1 ? '' : 's'} in progress`
			if (loop.closedCount > 0)
				return `${loop.closedCount} item${loop.closedCount === 1 ? '' : 's'} completed`
			return null
	}
}

/**
 * The flow's first target as a progress reading ("3 of 10 customers closed"),
 * read only from the targets already on the loop summary. Null when the flow
 * has no target, so the row simply has no progress line.
 */
export function loopProgress(loop: LoopSummary): {
	text: string
	percent: number
	missed: boolean
} | null {
	const target = loop.targets?.[0]
	if (!target || !(target.target > 0)) return null
	const percent = Math.max(0, Math.min(100, (target.actual / target.target) * 100))
	return {
		text: `${target.actual} of ${target.target} ${target.label}`.trim(),
		percent,
		missed: paceVerdict(target).label === 'Missed',
	}
}

function lastActivityText(loop: LoopSummary): string {
	// Live but idle: name the rung of the autonomy ladder it sits on
	// rather than a generic "Running", which no longer exists.
	return loopActivityLine(loop) ?? LOOP_PILL_STYLES[loop.pill].label
}

export function LoopRow({
	loop,
	actors,
	busyAgentCount = 0,
	showNoCreditsPill = false,
	onNoCreditsClick,
}: {
	loop: LoopSummary
	actors: ActorListItem[] | undefined
	/** How many of this loop's agents have a live session right now — drives the
	 *  green "busy" line under the stage label (mockup 1536). */
	busyAgentCount?: number
	/** True when the workspace is out of usage. When true and the loop's `pill` is
	 *  `paused`, the row renders the Upgrade overlay next to the state
	 *  label — parity with the Objects PAUSED · UPGRADE chip. */
	showNoCreditsPill?: boolean
	/** Invoked when the Upgrade pill is clicked; expected to open Billing,
	 *  the same place the left-nav Upgrade button goes. */
	onNoCreditsClick?: () => void
}) {
	const pill = LOOP_PILL_STYLES[loop.pill]
	const agentCards = loop.agentIds
		.map((id) => actors?.find((a) => a.id === id))
		.filter((a): a is ActorListItem => Boolean(a))
	const lastActor = agentCards[0]
	const activity = lastActivityText(loop)
	// The route's workspace-credits check already gates this; a per-row
	// `loop.pill === 'paused'` is the last predicate that keeps the overlay off
	// live and draft rows. Keeping it here (rather than in the parent) means the
	// route hands one boolean per workspace, not one per row.
	const noCreditsVisible = showNoCreditsPill && loop.pill === 'paused'
	const progress = loopProgress(loop)

	return (
		<Link
			to="/$workspaceId/loops/$loopId"
			params={{ workspaceId: loop.workspaceId, loopId: loop.id }}
			className="group flex items-center gap-3.5 border-b border-border px-3.5 py-4 transition-colors duration-150 hover:bg-muted"
		>
			<span
				title={pill.label}
				className={cn(
					'mx-1 h-2 w-2 shrink-0 rounded-full',
					pill.dot,
					isLiveLoopPill(loop.pill) && 'animate-pulse',
				)}
			/>
			<div className="min-w-0 flex-1 leading-[1.35]">
				<p className="truncate text-[15px] font-bold tracking-[-0.01em] text-foreground">
					{loop.name ?? 'Untitled flow'}
				</p>
				{loop.content && (
					<p className="mt-0.5 truncate text-[13px] text-muted-foreground">{loop.content}</p>
				)}
				{progress && (
					<div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
						<div
							role="progressbar"
							tabIndex={-1}
							aria-label={progress.text}
							aria-valuenow={Math.round(progress.percent)}
							aria-valuemin={0}
							aria-valuemax={100}
							className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-muted"
						>
							<div
								className={cn(
									'h-full rounded-full',
									progress.missed ? 'bg-destructive' : 'bg-primary',
								)}
								// Data-driven width: the one value a Tailwind class cannot carry.
								style={{ width: `${progress.percent}%` }}
							/>
						</div>
						<span className="truncate">{progress.text}</span>
					</div>
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
			<div className="flex shrink-0 items-center gap-2 text-right leading-[1.35]">
				{noCreditsVisible && (
					<TooltipProvider delayDuration={150}>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									data-testid="loop-pill-no-credits"
									aria-label={UPGRADE_PILL.ariaLabel}
									onClick={(event) => {
										// Stop the row-level <Link> from swallowing the click — the
										// pill's job is to open Billing, not the loop.
										event.preventDefault()
										event.stopPropagation()
										onNoCreditsClick?.()
									}}
									// NOT `.eyebrow` — that utility hard-codes `color: muted-foreground`
									// at higher specificity than `text-warning` and wins at runtime,
									// rendering the pill grey. Mirror the marketplace kind-label base
									// (`components/marketplace/item-type-label.ts:16`) instead so
									// `text-warning` actually paints amber in both themes.
									className="inline-flex shrink-0 items-center rounded-md bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.05em] text-warning transition-colors hover:bg-warning/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
								>
									<span className="hidden sm:inline">{UPGRADE_PILL.label}</span>
									<span className="sm:hidden">{UPGRADE_PILL.mobileLabel}</span>
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">{UPGRADE_PILL.tooltip}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
				{progress?.missed && (
					<span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
						Missed
					</span>
				)}
				<div>
					{/* Stage stands in for the mockup's per-loop stage label (1535).
					    `LoopSummary` carries no stage field, so this reads the pill —
					    a real stage needs a `stage` column on `loopSummarySchema`. */}
					<p data-testid="loop-pill" className={cn('text-xs font-semibold', pill.text)}>
						{pill.label}
					</p>
					{busyAgentCount > 0 && (
						<p className="mt-0.5 whitespace-nowrap text-[11px] text-success">
							{busyAgentCount} busy now
						</p>
					)}
				</div>
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
