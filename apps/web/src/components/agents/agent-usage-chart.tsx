import { DateRangePicker, type DateRangeValue } from '@/components/shared/date-range-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { pickBucket, useSessionUsage } from '@/hooks/use-session-usage'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type View = 'tokens' | 'cost'
type Preset = '24h' | '7d' | '30d' | 'all' | 'custom'
type TokenSeries = 'input' | 'output' | 'cache'

const TOKEN_SERIES_LABELS: Record<TokenSeries, string> = {
	input: 'Input',
	output: 'Output',
	cache: 'Cache',
}

const DAY_MS = 86_400_000
const PRESETS: { id: Preset; label: string }[] = [
	{ id: '24h', label: '24h' },
	{ id: '7d', label: '7d' },
	{ id: '30d', label: '30d' },
	{ id: 'all', label: 'All time' },
	{ id: 'custom', label: 'Custom' },
]

function presetRange(preset: Exclude<Preset, 'custom'>, agentCreatedAt?: string): DateRangeValue {
	const to = new Date()
	if (preset === 'all') {
		// Floor `from` to at least one day before `to` so the backend's
		// `to > from` guard always passes — even for brand-new agents with a
		// near-`now` createdAt or a missing/invalid timestamp.
		const parsed = agentCreatedAt ? new Date(agentCreatedAt) : null
		const fromMs = parsed && Number.isFinite(parsed.getTime()) ? parsed.getTime() : to.getTime()
		const from = new Date(Math.min(fromMs, to.getTime() - DAY_MS))
		return { from, to }
	}
	const days = preset === '24h' ? 1 : preset === '7d' ? 7 : 30
	const from = new Date(to.getTime() - days * DAY_MS)
	return { from, to }
}

const compactNumber = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})
const fullNumber = new Intl.NumberFormat('en-US')
const currency = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
})

function formatBucketLabel(iso: string, bucket: 'hour' | 'day' | 'week'): string {
	const d = new Date(iso)
	if (bucket === 'hour') {
		return d.toLocaleTimeString([], { hour: 'numeric' })
	}
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function AgentUsageChart({
	agent,
	workspaceId,
}: {
	agent: ActorResponse
	workspaceId: string
}) {
	const [view, setView] = useState<View>('tokens')
	const [preset, setPreset] = useState<Preset>('30d')
	const [customRange, setCustomRange] = useState<DateRangeValue>(() =>
		presetRange('30d', agent.createdAt ?? undefined),
	)

	const range: DateRangeValue = useMemo(() => {
		if (preset === 'custom') return customRange
		return presetRange(preset, agent.createdAt ?? undefined)
	}, [preset, customRange, agent.createdAt])

	const { data, isLoading, error } = useSessionUsage(workspaceId, agent.id, range.from, range.to)

	const chartBucket = useMemo(() => pickBucket(range.from.getTime(), range.to.getTime()), [range])

	const chartData = useMemo(() => {
		if (!data) return []
		return data.buckets.map((b) => ({
			bucket: b.bucket,
			label: formatBucketLabel(b.bucket, chartBucket),
			input: b.input_tokens,
			output: b.output_tokens,
			cache: b.cache_tokens,
			cost: b.total_cost_usd,
		}))
	}, [data, chartBucket])

	const totals = data?.totals

	return (
		<div className="mb-6">
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Usage
				</h3>
				<Tabs value={view} onValueChange={(v) => setView(v as View)}>
					<TabsList>
						<TabsTrigger value="tokens">Tokens</TabsTrigger>
						<TabsTrigger value="cost">Cost</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				{PRESETS.filter((p) => p.id !== 'custom').map((p) => (
					<Button
						key={p.id}
						variant={preset === p.id ? 'default' : 'outline'}
						size="sm"
						onClick={() => setPreset(p.id)}
					>
						{p.label}
					</Button>
				))}
				<DateRangePicker
					value={range}
					onChange={(r) => {
						setCustomRange(r)
						setPreset('custom')
					}}
					className={cn(preset === 'custom' && 'border-foreground')}
				/>
			</div>

			<div className="grid grid-cols-3 gap-4 mb-4">
				<Stat
					label="Total cost"
					value={totals ? currency.format(totals.total_cost_usd) : '—'}
					loading={isLoading}
				/>
				<Stat
					label="Total tokens"
					value={
						totals
							? fullNumber.format(totals.input_tokens + totals.output_tokens + totals.cache_tokens)
							: '—'
					}
					loading={isLoading}
				/>
				<Stat
					label="Sessions"
					value={totals ? fullNumber.format(totals.session_count) : '—'}
					loading={isLoading}
				/>
			</div>

			{isLoading ? (
				<Skeleton className="h-56 w-full" />
			) : error ? (
				<EmptyState
					title="Couldn't load usage"
					description={error instanceof Error ? error.message : undefined}
				/>
			) : chartData.length === 0 ? (
				<EmptyState
					title="No usage in this range"
					description="Once this agent runs sessions, cost and token usage will appear here."
				/>
			) : (
				<div className="h-56 w-full">
					<ResponsiveContainer>
						<BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
							<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
							<XAxis
								dataKey="label"
								tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
								tickLine={false}
								axisLine={false}
							/>
							<YAxis
								tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
								tickLine={false}
								axisLine={false}
								tickFormatter={(v: number) =>
									view === 'cost' ? `$${compactNumber.format(v)}` : compactNumber.format(v)
								}
								width={48}
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
								formatter={(value, name) => {
									const n = Number(value)
									if (view === 'cost') return [currency.format(n), 'Cost']
									return [fullNumber.format(n), TOKEN_SERIES_LABELS[name as TokenSeries] ?? name]
								}}
							/>
							{view === 'cost' ? (
								<Bar dataKey="cost" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={32} />
							) : (
								<>
									<Bar dataKey="input" stackId="tokens" fill="var(--primary)" maxBarSize={32} />
									<Bar
										dataKey="output"
										stackId="tokens"
										fill="var(--primary)"
										fillOpacity={0.65}
										maxBarSize={32}
									/>
									<Bar
										dataKey="cache"
										stackId="tokens"
										fill="var(--primary)"
										fillOpacity={0.35}
										radius={[3, 3, 0, 0]}
										maxBarSize={32}
									/>
								</>
							)}
						</BarChart>
					</ResponsiveContainer>
				</div>
			)}
		</div>
	)
}

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
	return (
		<div className="rounded-md border bg-card p-3">
			<div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
			{loading ? (
				<Skeleton className="h-5 w-16 mt-1" />
			) : (
				<div className="text-lg font-medium tabular-nums mt-0.5">{value}</div>
			)}
		</div>
	)
}
