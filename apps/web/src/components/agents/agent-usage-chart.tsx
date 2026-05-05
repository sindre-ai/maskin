import { DateRangePicker, type DateRangeValue } from '@/components/shared/date-range-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSessionUsage } from '@/hooks/use-session-usage'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type View = 'tokens' | 'cost'
type Preset = '24h' | '7d' | '30d' | 'all' | 'custom'

const DAY_MS = 86_400_000
const PRESETS: { id: Preset; label: string }[] = [
	{ id: '24h', label: '24h' },
	{ id: '7d', label: '7d' },
	{ id: '30d', label: '30d' },
	{ id: 'all', label: 'All time' },
	{ id: 'custom', label: 'Custom' },
]

function presetRange(preset: Exclude<Preset, 'custom'>, agentCreatedAt: string): DateRangeValue {
	const to = new Date()
	if (preset === 'all') {
		const from = new Date(agentCreatedAt)
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
		presetRange('30d', agent.createdAt ?? new Date().toISOString()),
	)

	const range: DateRangeValue = useMemo(() => {
		if (preset === 'custom') return customRange
		return presetRange(preset, agent.createdAt ?? new Date().toISOString())
	}, [preset, customRange, agent.createdAt])

	const { data, isLoading, error } = useSessionUsage(workspaceId, agent.id, range.from, range.to)

	const chartBucket = useMemo<'hour' | 'day' | 'week'>(() => {
		const span = (range.to.getTime() - range.from.getTime()) / DAY_MS
		if (span < 2) return 'hour'
		if (span <= 90) return 'day'
		return 'week'
	}, [range])

	const chartData = useMemo(() => {
		if (!data) return []
		return data.buckets.map((b) => ({
			bucket: b.bucket,
			label: formatBucketLabel(b.bucket, chartBucket),
			tokens: b.input_tokens + b.output_tokens,
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
					value={totals ? fullNumber.format(totals.input_tokens + totals.output_tokens) : '—'}
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
								formatter={(value) => {
									const n = Number(value)
									if (view === 'cost') return [currency.format(n), 'Cost']
									return [fullNumber.format(n), 'Tokens']
								}}
							/>
							<Bar dataKey={view} fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={32} />
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
