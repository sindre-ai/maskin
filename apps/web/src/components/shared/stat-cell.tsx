import { cn } from '@/lib/cn'

export interface SparkBarProps {
	data: number[]
	/** Container height in px; bars scale proportionally to fill it. */
	height?: number
	/** Tailwind fill utilities applied to every bar (tokens only). */
	barClassName?: string
	className?: string
}

/**
 * Inline mini bar-spark: a row of thin vertical bars scaled to the max value.
 * Fill comes from tokens (`barClassName`, default `bg-primary`); no colour or
 * radius literals live here.
 */
export function SparkBar({
	data,
	height = 46,
	barClassName = 'bg-primary',
	className,
}: SparkBarProps) {
	const max = Math.max(0, ...data)
	return (
		<div
			role="img"
			aria-label="Spark bar"
			className={cn('flex items-end gap-0.5', className)}
			style={{ height }}
		>
			{data.map((value, index) => {
				const percent = max === 0 ? 0 : Math.max(2, Math.round((value / max) * 100))
				return (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: static spark bars never reorder
						key={index}
						className={cn('min-w-0 flex-1 rounded-sm', barClassName)}
						style={{ height: `${percent}%` }}
					/>
				)
			})}
		</div>
	)
}

export type StatDeltaTone = 'neutral' | 'positive' | 'negative'

export interface StatCellProps {
	label: string
	value: string
	delta?: string
	deltaTone?: StatDeltaTone
	/** Optional inline spark series rendered under the value row. */
	spark?: number[]
	className?: string
}

const toneClass: Record<StatDeltaTone, string> = {
	neutral: 'text-muted-foreground',
	positive: 'text-success',
	negative: 'text-error',
}

/**
 * Compact stat cell: value + muted label (+ optional delta) with an inline
 * spark bar beneath. Renders as a single flex cell; wrap several in a
 * `flex flex-wrap` row (mockup stat-cell spec) and the dividers line up.
 */
export function StatCell({
	label,
	value,
	delta,
	deltaTone = 'neutral',
	spark,
	className,
}: StatCellProps) {
	return (
		<div
			className={cn(
				'min-w-52 flex-1 border-e border-border px-4 py-3.5 last:border-e-0',
				className,
			)}
		>
			<div className="flex items-baseline gap-1.5">
				<span className="text-lg font-bold tracking-tight tabular-nums">{value}</span>
				<span className="text-xs text-muted-foreground">{label}</span>
				{delta ? (
					<span className={cn('ml-auto text-xs font-semibold', toneClass[deltaTone])}>{delta}</span>
				) : null}
			</div>
			{spark && spark.length > 0 ? <SparkBar data={spark} className="mt-3" /> : null}
		</div>
	)
}
