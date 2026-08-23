import { cn } from '@/lib/cn'

export interface MiniBar {
	value: number
	label: string
}

const MIN_BAR_HEIGHT_PCT = 4

export function MiniBarChart({
	bars,
	className,
	heightClassName = 'h-12',
	'aria-label': ariaLabel,
}: {
	bars: MiniBar[]
	className?: string
	heightClassName?: string
	'aria-label'?: string
}) {
	const max = bars.reduce((acc, b) => (b.value > acc ? b.value : acc), 0)
	return (
		<div
			className={cn('flex items-end gap-[2px]', heightClassName, className)}
			role="img"
			aria-label={ariaLabel}
		>
			{bars.map((bar, idx) => {
				const pct =
					max > 0 ? Math.max((bar.value / max) * 100, bar.value > 0 ? MIN_BAR_HEIGHT_PCT : 0) : 0
				return (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-window bar chart has no stable id
						key={idx}
						title={bar.label}
						className={cn('flex-1 rounded-sm', bar.value > 0 ? 'bg-primary/60' : 'bg-muted')}
						style={{ height: `${pct}%` }}
					/>
				)
			})}
		</div>
	)
}
