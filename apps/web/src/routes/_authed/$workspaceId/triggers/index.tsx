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

function TriggersPage() {
	const { workspaceId } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)

	const tabs = useMemo(() => {
		const types = new Set((triggers ?? []).map((t) => t.type))
		return [
			{ label: 'All', value: undefined as string | undefined },
			...[...types].map((t) => ({
				label: t.charAt(0).toUpperCase() + t.slice(1),
				value: t as string | undefined,
			})),
		]
	}, [triggers])

	const counts = useMemo(() => {
		const list = triggers ?? []
		const c: Record<string, number> = { all: list.length }
		for (const t of list) {
			c[t.type] = (c[t.type] ?? 0) + 1
		}
		return c
	}, [triggers])

	const filtered = useMemo(
		() => (typeFilter ? (triggers ?? []).filter((t) => t.type === typeFilter) : (triggers ?? [])),
		[triggers, typeFilter],
	)

	return (
		<div>
			<PageHeader title="Triggers" />

			{isLoading ? (
				<ListSkeleton />
			) : !triggers?.length ? (
				<EmptyState title="No triggers" description="Create a trigger to automate agent actions" />
			) : (
				<>
					<div className="flex gap-1 mb-4">
						{tabs.map((tab) => (
							<button
								key={tab.label}
								type="button"
								className={cn(
									'rounded px-3 py-1 text-sm',
									typeFilter === tab.value
										? 'bg-muted text-foreground font-medium'
										: 'text-muted-foreground hover:text-foreground',
								)}
								onClick={() => setTypeFilter(tab.value)}
							>
								{tab.label} ({counts[tab.value ?? 'all'] ?? 0})
							</button>
						))}
					</div>
					<div className="space-y-2">
						{filtered.map((trigger) => {
							const agent = actors?.find((a) => a.id === trigger.targetActorId)
							return (
								<TriggerRow
									key={trigger.id}
									trigger={trigger}
									workspaceId={workspaceId}
									agentName={agent?.name ?? 'Unknown'}
								/>
							)
						})}
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
