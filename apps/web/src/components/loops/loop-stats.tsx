import type { LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatLoopDurationMs } from '@/lib/loop-duration'
import { isLiveLoopPill } from './loop-pill'

export function LoopStats({ loop }: { loop: LoopSummary }) {
	const isWaiting = loop.pill === 'waiting_on_you'
	const inProgressColor = isWaiting
		? 'text-warning'
		: isLiveLoopPill(loop.pill)
			? 'text-success'
			: 'text-foreground'
	const median = formatLoopDurationMs(loop.medianTimeToCloseMs)

	// The live tile carries a pulsing dot while work is actually moving through
	// the loop (mockup 1875) — a dot on a zero count would be theatre.
	const stats: { value: string; label: string; className?: string; live?: boolean }[] = [
		{
			value: String(loop.inProgressCount),
			label: 'in progress',
			className: inProgressColor,
			live: isLiveLoopPill(loop.pill) && loop.inProgressCount > 0,
		},
		{ value: String(loop.closedCount), label: 'closed' },
		{ value: median ?? '—', label: 'median to close' },
	]

	return (
		<div
			className="flex flex-wrap rounded-xl border border-border bg-card overflow-hidden shadow-sm"
			data-testid="loop-stats"
		>
			{stats.map((stat) => (
				<div
					key={stat.label}
					className="flex-1 min-w-[104px] px-4 py-3 border-r border-border last:border-r-0"
				>
					<div className="flex items-center gap-1.5">
						{stat.live && (
							<span
								aria-hidden="true"
								className={cn('size-[7px] shrink-0 animate-pulse rounded-full', 'bg-success')}
							/>
						)}
						<span className={cn('text-xl font-semibold tracking-tight', stat.className)}>
							{stat.value}
						</span>
					</div>
					<div className="text-xs text-muted-foreground mt-0.5">{stat.label}</div>
				</div>
			))}
		</div>
	)
}
