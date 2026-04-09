import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useTriggers } from '@/hooks/use-triggers'
import type { TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

type TypeFilter = 'all' | 'cron' | 'event' | 'reminder'
type StatusFilter = 'all' | 'enabled' | 'disabled'

const typeTabs: { label: string; value: TypeFilter }[] = [
	{ label: 'All', value: 'all' },
	{ label: 'Cron', value: 'cron' },
	{ label: 'Event', value: 'event' },
	{ label: 'Reminder', value: 'reminder' },
]

const statusTabs: { label: string; value: StatusFilter }[] = [
	{ label: 'All', value: 'all' },
	{ label: 'Enabled', value: 'enabled' },
	{ label: 'Disabled', value: 'disabled' },
]

function TriggersPage() {
	const { workspaceId } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

	const allTriggers = triggers ?? []

	const typeCounts = useMemo(() => {
		const c = { all: allTriggers.length, cron: 0, event: 0, reminder: 0 }
		for (const t of allTriggers) {
			const type = t.type as 'cron' | 'event' | 'reminder'
			if (type in c) c[type]++
		}
		return c
	}, [allTriggers])

	const statusCounts = useMemo(() => {
		const c = { all: allTriggers.length, enabled: 0, disabled: 0 }
		for (const t of allTriggers) {
			c[t.enabled ? 'enabled' : 'disabled']++
		}
		return c
	}, [allTriggers])

	const filtered = useMemo(
		() =>
			allTriggers.filter((t) => {
				if (typeFilter !== 'all' && t.type !== typeFilter) return false
				if (statusFilter === 'enabled' && !t.enabled) return false
				if (statusFilter === 'disabled' && t.enabled) return false
				return true
			}),
		[allTriggers, typeFilter, statusFilter],
	)

	return (
		<div>
			<PageHeader title="Triggers" />

			{isLoading ? (
				<ListSkeleton />
			) : !allTriggers.length ? (
				<EmptyState title="No triggers" description="Create a trigger to automate agent actions" />
			) : (
				<>
					<div className="flex gap-4 mb-4 flex-wrap">
						<div className="flex gap-1">
							{typeTabs.map((tab) => (
								<button
									key={tab.value}
									type="button"
									className={cn(
										'rounded px-3 py-1 text-sm',
										typeFilter === tab.value
											? 'bg-muted text-foreground font-medium'
											: 'text-muted-foreground hover:text-foreground',
									)}
									onClick={() => setTypeFilter(tab.value)}
								>
									{tab.label} ({typeCounts[tab.value]})
								</button>
							))}
						</div>
						<div className="flex gap-1">
							{statusTabs.map((tab) => (
								<button
									key={tab.value}
									type="button"
									className={cn(
										'rounded px-3 py-1 text-sm',
										statusFilter === tab.value
											? 'bg-muted text-foreground font-medium'
											: 'text-muted-foreground hover:text-foreground',
									)}
									onClick={() => setStatusFilter(tab.value)}
								>
									{tab.label} ({statusCounts[tab.value]})
								</button>
							))}
						</div>
					</div>

					<div className="space-y-2">
						{filtered.length === 0 ? (
							<EmptyState title="No matching triggers" description="Try changing the filters" />
						) : (
							filtered.map((trigger) => {
								const agent = actors?.find((a) => a.id === trigger.targetActorId)
								return (
									<TriggerRow
										key={trigger.id}
										trigger={trigger}
										workspaceId={workspaceId}
										agentName={agent?.name ?? 'Unknown'}
									/>
								)
							})
						)}
					</div>
				</>
			)}
		</div>
	)
}

function TriggerRow({
	trigger,
	workspaceId,
	agentName,
}: {
	trigger: TriggerResponse
	workspaceId: string
	agentName: string
}) {
	return (
		<Link
			to="/$workspaceId/triggers/$triggerId"
			params={{ workspaceId, triggerId: trigger.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
		>
			<span
				className={`h-3 w-3 rounded-full shrink-0 ${trigger.enabled ? 'bg-success' : 'bg-zinc-600'}`}
			/>
			<div className="flex-1">
				<p className="text-sm font-medium text-foreground">{trigger.name}</p>
				<p className="text-xs text-muted-foreground">
					{trigger.type} → {agentName}
				</p>
			</div>
		</Link>
	)
}
