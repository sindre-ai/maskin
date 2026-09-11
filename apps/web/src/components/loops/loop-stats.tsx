import type { LoopSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatLoopDurationMs } from '@/lib/loop-duration'
import { isLiveLoopPill } from './loop-pill'

interface Tile {
	value: string
	label: string
	className?: string
	live?: boolean
}

interface LoopStatsProps {
	loop: LoopSummary
	/** Live cycles count. When any of the three new props are provided the
	 * component renders the v4 5-tile strip; when all are undefined it renders
	 * the pre-v4 3-tile strip. Boundary lives at the /loops/:id route (see the
	 * `loops-v4-polish` flag read there); LoopStats itself doesn't read the
	 * flag so the same component covers both branches without a scattered
	 * check. */
	cyclesRunning?: number
	asksWaiting?: number
	nextFire?: string | null
}

export function LoopStats({ loop, cyclesRunning, asksWaiting, nextFire }: LoopStatsProps) {
	const isWaiting = loop.pill === 'waiting_on_you'
	const inProgressColor = isWaiting
		? 'text-warning'
		: isLiveLoopPill(loop.pill)
			? 'text-success'
			: 'text-foreground'
	const median = formatLoopDurationMs(loop.medianTimeToCloseMs) ?? '—'

	// The v4 strip renders when the caller passes any of the three new props.
	// Otherwise fall back to the pre-v4 shape.
	const isV4 = cyclesRunning !== undefined || asksWaiting !== undefined || nextFire !== undefined

	if (!isV4) {
		// The live tile carries a pulsing dot while work is actually moving through
		// the loop (mockup 1875) — a dot on a zero count would be theatre.
		const stats: Tile[] = [
			{
				value: String(loop.inProgressCount),
				label: 'in progress',
				className: inProgressColor,
				live: isLiveLoopPill(loop.pill) && loop.inProgressCount > 0,
			},
			{ value: String(loop.closedCount), label: 'closed' },
			{ value: median, label: 'median to close' },
		]
		return (
			<div
				className="flex flex-wrap rounded-xl border border-border bg-card overflow-hidden shadow-sm"
				data-testid="loop-stats"
			>
				{stats.map((stat) => (
					<StatTile key={stat.label} stat={stat} />
				))}
			</div>
		)
	}

	const runningValue = cyclesRunning ?? 0
	const asksValue = asksWaiting ?? 0

	// Labels are taken verbatim from the design SPEC's per-tile list — see
	// `bet-loops-polish-SPEC.md` under "Copy › Detail body › Summary tile labels".
	// `cyclesRunning` shows the pulsing dot only while the loop is actually
	// running work (same guard the pre-v4 tile used, but now driven by an
	// explicit count rather than `inProgressCount`).
	const runningTile: Tile = {
		value: String(runningValue),
		label: 'Cycles running',
		className: inProgressColor,
		live: isLiveLoopPill(loop.pill) && runningValue > 0,
	}
	const closedTile: Tile = { value: String(loop.closedCount), label: 'Closed this month' }
	const medianTile: Tile = { value: median, label: 'Median cycle time' }
	const asksTile: Tile = {
		value: String(asksValue),
		label: 'Asks waiting',
		className: asksValue > 0 ? 'text-warning' : undefined,
	}
	const nextFireTile: Tile = { value: nextFire ?? '—', label: 'Next fire' }

	// Grid layout carries the SPEC's responsive rules directly:
	// - mobile (<640px): 2×2 with Next fire spanning both columns on its own row
	// - tablet (641–1024px, sm/md): 3+2 (three across, then two)
	// - desktop (lg+): all five side-by-side
	// The single-px grid gap over a `bg-border` background paints the internal
	// hairlines automatically at any breakpoint — no per-cell nth-child math to
	// re-do when the column count changes.
	return (
		<div
			className={cn(
				'grid gap-px overflow-hidden rounded-xl border border-border bg-border shadow-sm',
				'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
			)}
			data-testid="loop-stats"
		>
			<StatTile stat={runningTile} />
			<StatTile stat={closedTile} />
			<StatTile stat={medianTile} />
			<StatTile stat={asksTile} />
			<StatTile stat={nextFireTile} className="col-span-2 sm:col-span-1" />
		</div>
	)
}

function StatTile({ stat, className }: { stat: Tile; className?: string }) {
	return (
		<div className={cn('min-w-[104px] bg-card px-4 py-3', className)}>
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
			<div className="mt-0.5 text-xs text-muted-foreground">{stat.label}</div>
		</div>
	)
}
