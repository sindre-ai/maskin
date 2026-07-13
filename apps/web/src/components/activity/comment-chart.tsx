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

export interface ChartSpec {
	type: 'bar' | 'line' | 'area'
	x: string
	series: string[]
	data: Array<Record<string, unknown>>
	caption?: string
}

export interface ChartParseSuccess {
	ok: true
	spec: ChartSpec
}
export interface ChartParseFailure {
	ok: false
	reason: string
}

const compactNumber = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})
const fullNumber = new Intl.NumberFormat('en-US')

const SUPPORTED_TYPES = new Set(['bar', 'line', 'area'])

export function parseChartSpec(raw: string): ChartParseSuccess | ChartParseFailure {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : 'invalid JSON',
		}
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'chart spec must be a JSON object' }
	}
	const obj = parsed as Record<string, unknown>
	const type = obj.type
	if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
		return { ok: false, reason: `unknown chart type "${String(type)}"` }
	}
	const x = obj.x
	if (typeof x !== 'string' || x.length === 0) {
		return { ok: false, reason: 'chart spec is missing the "x" field' }
	}
	const series = obj.series
	if (
		!Array.isArray(series) ||
		series.length === 0 ||
		!series.every((s) => typeof s === 'string' && s.length > 0)
	) {
		return { ok: false, reason: 'chart spec needs a non-empty "series" array of strings' }
	}
	const data = obj.data
	if (!Array.isArray(data)) {
		return { ok: false, reason: 'chart spec needs a "data" array' }
	}
	const cleanedData = data.filter(
		(row): row is Record<string, unknown> =>
			!!row && typeof row === 'object' && !Array.isArray(row),
	)
	const caption = typeof obj.caption === 'string' ? obj.caption : undefined
	return {
		ok: true,
		spec: {
			type: type as ChartSpec['type'],
			x,
			series: series as string[],
			data: cleanedData,
			caption,
		},
	}
}

function CommentChartFallback({ reason }: { reason: string }) {
	return (
		<div
			role="note"
			className="my-1 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
		>
			Couldn’t render chart — {reason}.
		</div>
	)
}

interface CommentChartProps {
	spec: ChartSpec
	className?: string
}

export function CommentChart({ spec, className }: CommentChartProps) {
	const seriesOpacities = useMemo(
		() => spec.series.map((_s, idx) => (idx === 0 ? 1 : Math.max(0.35, 1 - idx * 0.25))),
		[spec.series],
	)

	const Renderer = (() => {
		const commonProps = {
			data: spec.data,
			margin: { top: 8, right: 8, bottom: 0, left: 0 },
		}
		const axes = (
			<>
				<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
				<XAxis
					dataKey={spec.x}
					tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
					tickLine={false}
					axisLine={false}
				/>
				<YAxis
					tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
					tickLine={false}
					axisLine={false}
					tickFormatter={(v: number) => compactNumber.format(v)}
					width={40}
				/>
				<Tooltip
					cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
					contentStyle={{
						background: 'var(--popover)',
						border: '1px solid var(--border)',
						borderRadius: 6,
						fontSize: 12,
					}}
					labelStyle={{ color: 'var(--muted-foreground)', fontSize: 11 }}
					formatter={(value, name) => [
						typeof value === 'number' ? fullNumber.format(value) : String(value),
						String(name),
					]}
				/>
			</>
		)
		if (spec.type === 'bar') {
			return (
				<BarChart {...commonProps}>
					{axes}
					{spec.series.map((key, idx) => (
						<Bar
							key={key}
							dataKey={key}
							fill="var(--primary)"
							fillOpacity={seriesOpacities[idx]}
							radius={[3, 3, 0, 0]}
							maxBarSize={32}
						/>
					))}
				</BarChart>
			)
		}
		if (spec.type === 'line') {
			return (
				<LineChart {...commonProps}>
					{axes}
					{spec.series.map((key, idx) => (
						<Line
							key={key}
							type="monotone"
							dataKey={key}
							stroke="var(--primary)"
							strokeOpacity={seriesOpacities[idx]}
							strokeWidth={2}
							dot={false}
						/>
					))}
				</LineChart>
			)
		}
		return (
			<AreaChart {...commonProps}>
				{axes}
				{spec.series.map((key, idx) => (
					<Area
						key={key}
						type="monotone"
						dataKey={key}
						stroke="var(--primary)"
						strokeOpacity={seriesOpacities[idx]}
						fill="var(--primary)"
						fillOpacity={Math.max(0.1, (seriesOpacities[idx] ?? 0.5) * 0.4)}
					/>
				))}
			</AreaChart>
		)
	})()

	return (
		<figure className={cn('my-2 w-full max-w-full overflow-hidden', className)}>
			<div className="h-48 w-full">
				<ResponsiveContainer>{Renderer}</ResponsiveContainer>
			</div>
			{spec.caption && (
				<figcaption className="mt-1 text-xs text-muted-foreground">{spec.caption}</figcaption>
			)}
		</figure>
	)
}

export { CommentChartFallback }
