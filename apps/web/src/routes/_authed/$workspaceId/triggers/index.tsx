import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useLoops } from '@/hooks/use-loops'
import { useTriggers, useUpdateTrigger } from '@/hooks/use-triggers'
import type { TriggerResponse } from '@/lib/api'
import { splitTriggersByFlow } from '@/lib/triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

/**
 * Settings -> Workspace tools -> Triggers: every trigger in the workspace, the
 * ones a flow owns and the ones that run on their own. The flows list shows the
 * second group too; this page is the one place that lists both.
 */
export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggersRoute() {
	useDocumentTitle('Triggers')
	const { workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const triggersQuery = useTriggers(workspaceId)
	const { data: loops, isLoading: loopsLoading } = useLoops(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const [createOpen, setCreateOpen] = useState(false)

	const { inFlows, standalone } = useMemo(
		() => splitTriggersByFlow(triggersQuery.data ?? [], loops ?? []),
		[triggersQuery.data, loops],
	)

	const renderRow = (trigger: TriggerResponse) => {
		const agent = actors?.find((a) => a.id === trigger.targetActorId)
		return (
			<TriggerRow
				key={trigger.id}
				trigger={trigger}
				workspaceId={workspaceId}
				agentId={agent?.id}
				agentType={agent?.type}
				agentName={agent?.name ?? 'Unknown'}
				isToggling={updateTrigger.isPending}
				onToggleEnabled={(next) => {
					if (!canWrite) return
					updateTrigger.mutate({ id: trigger.id, data: { enabled: next } })
				}}
				v4Polish
			/>
		)
	}

	const loading = triggersQuery.isLoading || loopsLoading

	return (
		<div className="mx-auto w-full max-w-[760px]">
			<PageHeader
				title="Triggers"
				crumb={{
					parentLabel: 'Settings',
					parentTo: '/$workspaceId/settings',
					parentParams: { workspaceId },
					label: 'Triggers',
				}}
				actions={
					<ViewerTooltip>
						<Button size="sm" disabled={!canWrite} onClick={() => setCreateOpen(true)}>
							<Plus size={14} aria-hidden />
							New trigger
						</Button>
					</ViewerTooltip>
				}
			/>
			{loading ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : triggersQuery.isError ? (
				<QueryStateError
					title="Couldn't load triggers"
					error={triggersQuery.error ?? new Error('Something went wrong.')}
					onRetry={() => triggersQuery.refetch()}
				/>
			) : (
				<div className="flex flex-col gap-8">
					<TriggerGroup title="In flows" emptyText="No flow has a trigger yet">
						{inFlows.map(renderRow)}
					</TriggerGroup>
					<TriggerGroup
						title="Not tied to a flow"
						emptyText="Every trigger belongs to a flow. A trigger made from an agent or an event appears here."
					>
						{standalone.map(renderRow)}
					</TriggerGroup>
				</div>
			)}
			<CreatePicker open={createOpen} onOpenChange={setCreateOpen} defaultType="trigger" />
		</div>
	)
}

function TriggerGroup({
	title,
	emptyText,
	children,
}: {
	title: string
	emptyText: string
	children: React.ReactNode[]
}) {
	return (
		<section>
			<h2 className="px-2 pb-2 text-xs font-semibold text-foreground">{title}</h2>
			{children.length === 0 ? (
				<EmptyState title={emptyText} className="py-6" />
			) : (
				<div className="flex flex-col gap-2">{children}</div>
			)}
		</section>
	)
}
