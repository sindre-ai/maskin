import { Skeleton } from '@/components/shared/loading-skeleton'
import { MiniBarChart } from '@/components/shared/mini-bar-chart'
import { Button } from '@/components/ui/button'
import { pickBucket, useSessionUsage } from '@/hooks/use-session-usage'
import type { ActorResponse, SessionUsageResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useMemo, useState } from 'react'

type Preset = '24h' | '7d' | '30d' | 'all'

const DAY_MS = 86_400_000
const PRESETS: { id: Preset; label: string; days: number | 'all' }[] = [
	{ id: '24h', label: '24h', days: 1 },
	{ id: '7d', label: '7d', days: 7 },
	{ id: '30d', label: '30d', days: 30 },
	{ id: 'all', label: 'All', days: 'all' },
]

const CHART_LABEL_BY_PRESET: Record<Preset, string> = {
	'24h': 'TOKENS / DAY',
	'7d': 'TOKENS / WEEK',
	'30d': 'TOKENS / MONTH',
	all: 'TOKENS / RANGE',
}

const compact = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})
const full = new Intl.NumberFormat('en-US')

function presetRange(preset: Preset, createdAt?: string | null): { from: Date; to: Date } {
	const to = new Date()
	if (preset === 'all') {
		const parsed = createdAt ? new Date(createdAt) : null
		const fromMs =
			parsed && Number.isFinite(parsed.getTime()) ? parsed.getTime() : to.getTime() - 30 * DAY_MS
		const from = new Date(Math.min(fromMs, to.getTime() - DAY_MS))
		return { from, to }
	}
	const days = preset === '24h' ? 1 : preset === '7d' ? 7 : 30
	return { from: new Date(to.getTime() - days * DAY_MS), to }
}

function priorRange(range: { from: Date; to: Date }): { from: Date; to: Date } {
	const span = range.to.getTime() - range.from.getTime()
	return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()) }
}

function totalTokens(totals: SessionUsageResponse['totals'] | undefined): number {
	if (!totals) return 0
	return totals.input_tokens + totals.output_tokens + totals.cache_tokens
}

function formatDelta(
	current: number,
	prior: number,
): { text: string; tone: 'up' | 'down' | 'flat' } {
	if (prior === 0) {
		if (current === 0) return { text: '±0%', tone: 'flat' }
		return { text: 'New', tone: 'up' }
	}
	const pct = ((current - prior) / prior) * 100
	if (Math.abs(pct) < 1) return { text: '±0%', tone: 'flat' }
	const sign = pct > 0 ? '+' : '−'
	return { text: `${sign}${Math.round(Math.abs(pct))}%`, tone: pct > 0 ? 'up' : 'down' }
}

function formatPeriodStart(from: Date, bucket: 'hour' | 'day' | 'week'): string {
	if (bucket === 'hour') {
		return `since ${from.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
	}
	return `since ${from.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

function formatAverage(count: number, buckets: number, unit: string): string {
	if (buckets === 0) return `${full.format(0)} ${unit}/day avg`
	const per = count / buckets
	return `${compact.format(per)} ${unit}/day avg`
}

const DELTA_TONE_CLASS: Record<'up' | 'down' | 'flat', string> = {
	up: 'text-success',
	down: 'text-error',
	flat: 'text-muted-foreground',
}

export function AgentUsageBlock({
	agent,
	workspaceId,
}: {
	agent: ActorResponse
	workspaceId: string
}) {
	const [preset, setPreset] = useState<Preset>('30d')
	const range = useMemo(() => presetRange(preset, agent.createdAt), [preset, agent.createdAt])
	const prior = useMemo(() => priorRange(range), [range])
	const bucket = useMemo(() => pickBucket(range.from.getTime(), range.to.getTime()), [range])

	const currentQuery = useSessionUsage(workspaceId, agent.id, range.from, range.to)
	const priorQuery = useSessionUsage(workspaceId, agent.id, prior.from, prior.to)

	const currentTokens = totalTokens(currentQuery.data?.totals)
	const priorTokens = totalTokens(priorQuery.data?.totals)
	const currentSessions = currentQuery.data?.totals.session_count ?? 0
	const priorSessions = priorQuery.data?.totals.session_count ?? 0

	const tokenDelta = formatDelta(currentTokens, priorTokens)
	const sessionDelta = formatDelta(currentSessions, priorSessions)

	const bucketCount = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS))

	const tokenBars = useMemo(() => {
		const buckets = currentQuery.data?.buckets ?? []
		return buckets.map((b) => ({
			value: b.input_tokens + b.output_tokens + b.cache_tokens,
			label: `${new Date(b.bucket).toLocaleDateString()}: ${full.format(
				b.input_tokens + b.output_tokens + b.cache_tokens,
			)} tokens`,
		}))
	}, [currentQuery.data])

	const sessionBars = useMemo(() => {
		const buckets = currentQuery.data?.buckets ?? []
		return buckets.map((b) => ({
			value: b.session_count,
			label: `${new Date(b.bucket).toLocaleDateString()}: ${b.session_count} sessions`,
		}))
	}, [currentQuery.data])

	const periodStart = formatPeriodStart(range.from, bucket)
	const isLoading = currentQuery.isLoading

	return (
		<section
			aria-label="Usage"
			className="overflow-hidden rounded-lg border border-border bg-bg-surface"
		>
			<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
				<span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
					Usage
				</span>
				<div className="ml-auto inline-flex items-center gap-1 rounded-md bg-muted p-0.5">
					{PRESETS.map((p) => (
						<Button
							key={p.id}
							type="button"
							size="sm"
							variant={preset === p.id ? 'default' : 'ghost'}
							className="h-6 rounded px-2.5 text-[11px]"
							aria-pressed={preset === p.id}
							onClick={() => setPreset(p.id)}
						>
							{p.label}
						</Button>
					))}
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2">
				<UsageColumn
					title="tokens used"
					isLoading={isLoading}
					total={currentTokens}
					delta={tokenDelta}
					bars={tokenBars}
					chartLabel={CHART_LABEL_BY_PRESET[preset]}
					periodStart={periodStart}
					averageLine={formatAverage(currentTokens, bucketCount, 'tokens')}
					showBudget
					className="border-b border-border md:border-b-0 md:border-r"
				/>
				<UsageColumn
					title="sessions"
					isLoading={isLoading}
					total={currentSessions}
					delta={sessionDelta}
					bars={sessionBars}
					chartLabel="SESSIONS / RANGE"
					periodStart={periodStart}
					averageLine={formatAverage(currentSessions, bucketCount, 'sessions')}
				/>
			</div>
		</section>
	)
}

function UsageColumn({
	title,
	isLoading,
	total,
	delta,
	bars,
	chartLabel,
	periodStart,
	averageLine,
	showBudget = false,
	className,
}: {
	title: string
	isLoading: boolean
	total: number
	delta: { text: string; tone: 'up' | 'down' | 'flat' }
	bars: { value: number; label: string }[]
	chartLabel: string
	periodStart: string
	averageLine: string
	showBudget?: boolean
	className?: string
}) {
	return (
		<div className={cn('flex flex-col gap-3 px-4 py-4', className)}>
			<div className="flex items-baseline gap-2">
				{isLoading ? (
					<Skeleton className="h-6 w-20" />
				) : (
					<span className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
						{full.format(total)}
					</span>
				)}
				<span className="text-xs text-muted-foreground">{title}</span>
				<span
					className={cn('ml-auto text-xs font-medium tabular-nums', DELTA_TONE_CLASS[delta.tone])}
					aria-label={`change vs prior period ${delta.text}`}
				>
					{delta.text}
				</span>
			</div>

			<div>
				<div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
					{chartLabel}
				</div>
				{isLoading ? (
					<Skeleton className="h-12 w-full" />
				) : bars.length === 0 ? (
					<div className="flex h-12 items-center text-xs text-muted-foreground">No usage yet</div>
				) : (
					<MiniBarChart bars={bars} aria-label={`${title} over time`} />
				)}
			</div>

			<div className="flex items-center text-[10px] text-muted-foreground">
				<span>{periodStart}</span>
				<span className="ml-auto tabular-nums">{averageLine}</span>
			</div>

			{showBudget && (
				<div className="mt-1 flex items-center gap-2 border-t border-border pt-3">
					<div className="h-1 flex-1 rounded-full bg-muted">
						<span className="block h-1 w-0 rounded-full bg-primary/40" />
					</div>
					<span className="text-[10px] font-medium text-muted-foreground">Budget: No cap</span>
				</div>
			)}
		</div>
	)
}
