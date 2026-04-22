import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useMetrics } from '@/hooks/use-metrics'
import type { MetricsResponse } from '@/lib/api'
import { createFileRoute } from '@tanstack/react-router'
import { BarChart3, Bot, Clock, Layers, Link2, Zap } from 'lucide-react'

export const Route = createFileRoute('/_authed/$workspaceId/metrics')({
	component: MetricsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function formatHours(seconds: number) {
	const hours = seconds / 3600
	if (hours < 1) return `${Math.round(seconds / 60)}m`
	return `${Math.round(hours * 10) / 10}h`
}

function StatCard({
	title,
	value,
	description,
	icon: Icon,
}: {
	title: string
	value: string | number
	description?: string
	icon: React.ComponentType<{ className?: string }>
}) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<CardTitle className="text-sm font-medium">{title}</CardTitle>
				<Icon className="h-4 w-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				<div className="text-2xl font-bold">{value}</div>
				{description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
			</CardContent>
		</Card>
	)
}

function StatCardSkeleton() {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-4 w-4" />
			</CardHeader>
			<CardContent>
				<Skeleton className="h-7 w-16 mb-1" />
				<Skeleton className="h-3 w-32" />
			</CardContent>
		</Card>
	)
}

function BreakdownCard({
	title,
	items,
	icon: Icon,
}: {
	title: string
	items: { label: string; count: number }[]
	icon: React.ComponentType<{ className?: string }>
}) {
	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<CardTitle className="text-sm font-medium">{title}</CardTitle>
				<Icon className="h-4 w-4 text-muted-foreground" />
			</CardHeader>
			<CardContent>
				{items.length === 0 ? (
					<p className="text-sm text-muted-foreground">No data yet</p>
				) : (
					<div className="space-y-2">
						{items.map((item) => (
							<div key={item.label} className="flex items-center justify-between">
								<span className="text-sm capitalize">{item.label}</span>
								<span className="text-sm font-medium font-mono">{item.count}</span>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	)
}

function MetricsDashboard({ metrics }: { metrics: MetricsResponse }) {
	return (
		<div className="space-y-6">
			{/* Top-level stats */}
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				<StatCard
					title="Workspaces"
					value={metrics.workspaces.total}
					description={`+${metrics.workspaces.daily} today, +${metrics.workspaces.weekly} this week`}
					icon={Layers}
				/>
				<StatCard
					title="Objects Created"
					value={metrics.objects.total}
					description={`+${metrics.objects.daily} today, +${metrics.objects.weekly} this week`}
					icon={BarChart3}
				/>
				<StatCard
					title="Agent Sessions"
					value={metrics.agents.sessionsRun}
					description={`+${metrics.agents.sessionsDaily} today, +${metrics.agents.sessionsWeekly} this week`}
					icon={Zap}
				/>
				<StatCard
					title="Agent Hours"
					value={formatHours(metrics.agentHours.totalSeconds)}
					description={`${formatHours(metrics.agentHours.weeklySeconds)} this week`}
					icon={Clock}
				/>
			</div>

			{/* Breakdowns */}
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				<StatCard title="Agents Configured" value={metrics.agents.configured} icon={Bot} />
				<BreakdownCard
					title="Objects by Type"
					items={metrics.objects.byType.map((t) => ({
						label: t.type,
						count: t.count,
					}))}
					icon={Layers}
				/>
				<BreakdownCard
					title="Integrations by Provider"
					items={metrics.integrations.byProvider.map((p) => ({
						label: p.provider,
						count: p.count,
					}))}
					icon={Link2}
				/>
			</div>

			<CardDescription className="text-center">
				Metrics refresh automatically every 30 seconds. All data is aggregate and
				privacy-respecting.
			</CardDescription>
		</div>
	)
}

function MetricsPage() {
	const { data: metrics, isLoading } = useMetrics()

	return (
		<div className="flex flex-col h-full min-h-0">
			<PageHeader title="Metrics" />

			<div className="flex-1 min-h-0 overflow-y-auto">
				{isLoading ? (
					<div className="space-y-6">
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
							<StatCardSkeleton />
							<StatCardSkeleton />
							<StatCardSkeleton />
							<StatCardSkeleton />
						</div>
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							<StatCardSkeleton />
							<StatCardSkeleton />
							<StatCardSkeleton />
						</div>
					</div>
				) : metrics ? (
					<MetricsDashboard metrics={metrics} />
				) : null}
			</div>
		</div>
	)
}
