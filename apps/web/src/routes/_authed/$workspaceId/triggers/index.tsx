import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useTriggers } from '@/hooks/use-triggers'
import type { TriggerResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggersPage() {
	const { workspaceId } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)

	return (
		<div>
			<PageHeader title="Triggers" />

			{isLoading ? (
				<ListSkeleton />
			) : !triggers?.length ? (
				<EmptyState title="No triggers" description="Create a trigger to automate agent actions" />
			) : (
				<div className="space-y-2">
					{triggers.map((trigger) => {
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
