import { cn } from '@/lib/cn'
import { useMemo } from 'react'
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts'

export type CommentChartType = 'bar' | 'line' | 'area'

export interface CommentChartSpec {
	type: CommentChartType
	x: string
	series: string[]
	data: Array<Record<string, unknown>>
	caption?: string
}

// Accepts a parsed JSON value and either returns a strongly-typed spec or null.
// Returning null (not throwing) lets the caller render a fallback inline.
export function parseChartSpec(input: unknown): CommentChartSpec | null {
	if (!input || typeof input !== 'object') return null
	const raw = input as Record<string, unknown>
	const type = raw.type
	if (type !== 'bar' && type !== 'line' && type !== 'area') return null
	if (typeof raw.x !== 'string' || raw.x.length === 0) return null
	if (!Array.isArray(raw.series) || raw.series.length === 0) return null
	const series = raw.series.filter((s): s is string => typeof s === 'string' && s.length > 0)
	if (series.length === 0) return null
	if (!Array.isArray(raw.data) || raw.data.length === 0) return null
	const data = raw.data.filter(
		(row): row is Record<string, unknown> =>
			!!row && typeof row === 'object' && !Array.isArray(row),
	)
	if (data.length === 0) return null
	const caption = typeof raw.caption === 'string' ? raw.caption : undefined
	return { type, x: raw.x, series, data, caption }
}

const compactNumber = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})
const fullNumber = new Intl.NumberFormat('en-US')

// Stacked-bar / multi-line opacity ramp — mirrors agent-usage-chart.tsx's
// single-colour-with-fading-opacity pattern so the chart sits visually beside
// existing charts in dark and light mode.
const SERIES_OPACITIES = [1, 0.65, 0.4, 0.25]

function seriesFillOpacity(index: number): number {
	return SERIES_OPACITIES[index] ?? 0.25
}

export function CommentChart({ spec, className }: { spec: CommentChartSpec; className?: string }) {
	const chartData = useMemo(
		() =>
			spec.data.map((row) => {
				// Coerce numerics — JSON may serialize them as strings (e.g. "0.42")
				// and recharts silently no-ops on string values.
				const next: Record<string, unknown> = { ...row }
				for (const key of spec.series) {
					const v = row[key]
					next[key] = typeof v === 'number' ? v : Number(v)
				}
				return next
			}),
		[spec],
	)

	const tooltipFormatter = (value: unknown, name: unknown) => {
		const n = Number(value)
		return [Number.isFinite(n) ? fullNumber.format(n) : String(value), String(name)]
	}

	const axisTick = { fontSize: 11, fill: 'var(--muted-foreground)' }
	const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
	const xAxis = <XAxis dataKey={spec.x} tick={axisTick} tickLine={false} axisLine={false} />
	const yAxis = (
		<YAxis
			tick={axisTick}
			tickLine={false}
			axisLine={false}
			tickFormatter={(v: number) => compactNumber.format(v)}
			width={36}
		/>
	)
	const tooltip = (
		<Tooltip
			cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
			contentStyle={{
				background: 'var(--popover)',
				border: '1px solid var(--border)',
				borderRadius: 6,
				fontSize: 12,
			}}
			labelStyle={{ color: 'var(--muted-foreground)', fontSize: 11 }}
			formatter={tooltipFormatter}
		/>
	)

	return (
		<figure
			data-testid="comment-chart"
			data-chart-type={spec.type}
			className={cn('not-prose my-2 max-w-full', className)}
		>
			<div className="h-44 w-full max-w-full overflow-hidden">
				<ResponsiveContainer>
					{spec.type === 'bar' ? (
						<BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
							{grid}
							{xAxis}
							{yAxis}
							{tooltip}
							{spec.series.map((key, i) => (
								<Bar
									key={key}
									dataKey={key}
									stackId={spec.series.length > 1 ? 'stack' : undefined}
									fill="var(--primary)"
									fillOpacity={seriesFillOpacity(i)}
									radius={i === spec.series.length - 1 ? [3, 3, 0, 0] : 0}
									maxBarSize={32}
								/>
							))}
						</BarChart>
					) : spec.type === 'line' ? (
						<LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
							{grid}
							{xAxis}
							{yAxis}
							{tooltip}
							{spec.series.map((key, i) => (
								<Line
									key={key}
									type="monotone"
									dataKey={key}
									stroke="var(--primary)"
									strokeOpacity={seriesFillOpacity(i)}
									strokeWidth={2}
									dot={false}
								/>
							))}
						</LineChart>
					) : (
						<AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
							{grid}
							{xAxis}
							{yAxis}
							{tooltip}
							{spec.series.map((key, i) => (
								<Area
									key={key}
									type="monotone"
									dataKey={key}
									stroke="var(--primary)"
									strokeOpacity={seriesFillOpacity(i)}
									fill="var(--primary)"
									fillOpacity={seriesFillOpacity(i) * 0.4}
								/>
							))}
						</AreaChart>
					)}
				</ResponsiveContainer>
			</div>
			{spec.caption && (
				<figcaption className="mt-1 text-xs text-muted-foreground">{spec.caption}</figcaption>
			)}
		</figure>
	)
}
