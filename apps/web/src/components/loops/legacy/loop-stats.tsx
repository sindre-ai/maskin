/**
 * Pre-v2 loop-stats, restored verbatim from before the v2 Loops/Triggers redesign.
 * Rendered when the `new-design` flag is OFF; the v2 replacement lives one
 * directory up. This whole directory dies with that flag
 * (`.claude/rules/feature-flags.md`).
 */
import type { LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatLoopDurationMs } from '@/lib/loop-duration'

export function LoopStats({ loop }: { loop: LoopSummary }) {
	const isWaiting = loop.pill === 'waiting_on_you'
	const isLive =
		loop.pill === 'learning' || loop.pill === 'supervised' || loop.pill === 'fully_autonomous'
	const inProgressColor = isWaiting ? 'text-warning' : isLive ? 'text-success' : 'text-foreground'
	const median = formatLoopDurationMs(loop.medianTimeToCloseMs)

	const stats: { value: string; label: string; className?: string }[] = [
		{ value: String(loop.inProgressCount), label: 'in progress', className: inProgressColor },
		{ value: String(loop.closedCount), label: 'closed' },
		{ value: median ?? '—', label: 'median to close' },
	]

	return (
		<div
			className="flex flex-wrap rounded-xl border border-border bg-card overflow-hidden"
			data-testid="loop-stats"
		>
			{stats.map((stat) => (
				<div
					key={stat.label}
					className="flex-1 min-w-[104px] px-4 py-3 border-r border-border last:border-r-0"
				>
					<div className={cn('text-xl font-semibold tracking-tight', stat.className)}>
						{stat.value}
					</div>
					<div className="text-xs text-muted-foreground mt-0.5">{stat.label}</div>
				</div>
			))}
		</div>
	)
}
