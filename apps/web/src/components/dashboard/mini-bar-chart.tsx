import { cn } from '@/lib/cn'

export interface MiniBarSegment {
	value: number
	color?: string
	label?: string
}

export interface MiniBarItem {
	label: string
	value?: number
	color?: string
	segments?: MiniBarSegment[]
}

export interface MiniBarChartProps {
	data: MiniBarItem[]
	height?: number
	className?: string
	formatValue?: (n: number) => string
	ariaLabel?: string
}

function totalOf(item: MiniBarItem): number {
	if (item.segments) return item.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
	return Math.max(0, item.value ?? 0)
}

export function MiniBarChart({
	data,
	height = 32,
	className,
	formatValue,
	ariaLabel = 'bar chart',
}: MiniBarChartProps) {
	const fmt = formatValue ?? ((n: number) => String(n))

	if (data.length === 0) {
		return (
			<div
				className={cn('flex items-end gap-1', className)}
				style={{ height }}
				role="img"
				aria-label={`${ariaLabel} (empty)`}
			/>
		)
	}

	const max = Math.max(1, ...data.map(totalOf))

	return (
		<div
			className={cn('flex items-end gap-1', className)}
			style={{ height }}
			role="img"
			aria-label={ariaLabel}
		>
			{data.map((item, i) => {
				const total = totalOf(item)
				const totalPct = (total / max) * 100
				const barTitle = `${item.label}: ${fmt(total)}`
				return (
					<div
						key={`${item.label}-${i}`}
						className="flex min-w-[4px] flex-1 flex-col items-center"
						title={barTitle}
					>
						<div
							className="flex w-full flex-col-reverse overflow-hidden rounded-sm bg-muted"
							style={{ height: `${totalPct}%`, minHeight: total > 0 ? 2 : 1 }}
						>
							{item.segments ? (
								item.segments.map((seg, j) => {
									const segValue = Math.max(0, seg.value)
									const segPct = total > 0 ? (segValue / total) * 100 : 0
									return (
										<div
											key={`${item.label}-seg-${j}`}
											className={cn('w-full', !seg.color && 'bg-accent')}
											style={{ height: `${segPct}%`, backgroundColor: seg.color }}
											aria-label={seg.label}
										/>
									)
								})
							) : (
								<div
									className={cn('h-full w-full', !item.color && 'bg-accent')}
									style={{ backgroundColor: item.color }}
								/>
							)}
						</div>
					</div>
				)
			})}
		</div>
	)
}
