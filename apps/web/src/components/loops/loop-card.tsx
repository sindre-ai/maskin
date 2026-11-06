import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import { useCreateSession } from '@/hooks/use-sessions'
import type { LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { toastSessionCreateError } from '@/lib/session-errors'
import { Link, useNavigate } from '@tanstack/react-router'
import type { FailedAgent } from './loop-brief'
import { LOOP_PILL_STYLES, isLiveLoopPill } from './loop-pill'
import { loopActivityLine, loopProgress } from './loop-row'
import { paceVerdict } from './target-card'

/** The word at the card's top right: "Needs you" while the flow waits on the viewer. */
export function loopStatusWord(loop: Pick<LoopSummary, 'pill' | 'status'>, needsYou: boolean) {
	if (needsYou) return { label: 'Needs you', text: LOOP_PILL_STYLES.waiting_on_you.text }
	return { label: LOOP_PILL_STYLES[loop.pill].label, text: LOOP_PILL_STYLES[loop.pill].text }
}

/**
 * The Cards view of a flow: the same data as a list row, led by one big number
 * with its progress bar: the first target, or for a flow with none, the items it
 * has completed out of those it has taken on. The grey banner (and Restart) exists only when an agent of the
 * flow failed.
 */
export function LoopCard({
	loop,
	needsYou,
	failed,
}: {
	loop: LoopSummary
	needsYou: boolean
	failed: FailedAgent | null
}) {
	const navigate = useNavigate()
	const canWrite = useCanWrite()
	const createSession = useCreateSession(loop.workspaceId)
	const status = loopStatusWord(loop, needsYou)
	const dot = needsYou ? LOOP_PILL_STYLES.waiting_on_you.dot : LOOP_PILL_STYLES[loop.pill].dot
	const target = loop.targets?.[0]
	const progress = loopProgress(loop)
	const prompt = failed?.session.actionPrompt?.trim() ?? ''
	const taken = loop.closedCount + loop.inProgressCount
	const metric =
		target && progress
			? {
					actual: target.actual,
					total: target.target,
					label: target.label,
					percent: progress.percent,
					missed: progress.missed,
					footnote: paceVerdict(target).label as string,
				}
			: {
					actual: loop.closedCount,
					total: taken,
					label: 'items completed',
					percent: taken > 0 ? (loop.closedCount / taken) * 100 : 0,
					missed: false,
					footnote: loopActivityLine(loop) ?? 'Nothing in this flow yet',
				}

	const restart = () => {
		if (!failed) return
		createSession.mutate(
			{
				actor_id: failed.agent.id,
				action_prompt: prompt,
				...(failed.session.triggerId ? { trigger_id: failed.session.triggerId } : {}),
			},
			{ onError: (err) => toastSessionCreateError(err, navigate, loop.workspaceId) },
		)
	}

	return (
		<div
			data-testid="loop-card"
			className="relative flex flex-col gap-3 rounded-xl bg-card px-[18px] py-4 shadow-sm ring-1 ring-border transition-shadow duration-150 hover:ring-border-strong"
		>
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						className={cn(
							'size-2 shrink-0 rounded-full',
							dot,
							isLiveLoopPill(loop.pill) && !needsYou && 'animate-pulse',
						)}
					/>
					<Link
						to="/$workspaceId/loops/$loopId"
						params={{ workspaceId: loop.workspaceId, loopId: loop.id }}
						className="truncate text-[13px] font-semibold text-foreground after:absolute after:inset-0 after:rounded-xl after:content-['']"
					>
						{loop.name ?? 'Untitled flow'}
					</Link>
				</div>
				<span data-testid="loop-pill" className={cn('shrink-0 text-xs font-semibold', status.text)}>
					{status.label}
				</span>
			</div>

			{/* Every card leads with a number and a bar, as in the design. A flow with a target shows
			    that target; one without shows what it has actually processed (items completed out
			    of items it has taken on), so the card never falls back to a text-only layout. */}
			<div className="flex flex-col gap-2">
				<div>
					<p className="text-4xl font-bold leading-[1.1] tracking-tighter tabular-nums text-foreground">
						{metric.total > 0 ? `${metric.actual} of ${metric.total}` : '0'}
					</p>
					<p className="mt-1.5 text-[12.5px] text-muted-foreground">{metric.label}</p>
				</div>
				<div
					{...(target && progress
						? {
								role: 'progressbar',
								tabIndex: -1,
								'aria-label': progress.text,
								'aria-valuenow': Math.round(progress.percent),
								'aria-valuemin': 0,
								'aria-valuemax': 100,
							}
						: { 'aria-hidden': true })}
					className="h-1.5 overflow-hidden rounded-full bg-muted"
				>
					<div
						className={cn('h-full rounded-full', metric.missed ? 'bg-destructive' : 'bg-brand')}
						// Data-driven width: the one value a Tailwind class cannot carry.
						style={{ width: `${metric.percent}%` }}
					/>
				</div>
				{!failed && <p className="text-[12px] text-muted-foreground">{metric.footnote}</p>}
			</div>

			{failed && (
				<div
					role="alert"
					className="relative z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl bg-muted px-3 py-2.5"
				>
					<span className="min-w-0 text-[12.5px] font-semibold text-foreground">
						{failed.agent.name} stopped on its last run
					</span>
					{prompt.length > 0 && (
						<ViewerTooltip>
							<Button
								size="sm"
								className="h-8 shrink-0 rounded-full px-3.5 text-[12px] font-semibold"
								onClick={restart}
								disabled={createSession.isPending || !canWrite}
							>
								{createSession.isPending ? 'Restarting…' : `Restart ${failed.agent.name}`}
							</Button>
						</ViewerTooltip>
					)}
				</div>
			)}
		</div>
	)
}
