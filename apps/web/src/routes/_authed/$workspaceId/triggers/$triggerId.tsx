import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerForm } from '@/components/triggers/trigger-form'
import type { TriggerFormPayload } from '@/components/triggers/trigger-form'
import { useActors } from '@/hooks/use-actors'
import { useDeleteTrigger, useTrigger, useUpdateTrigger } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/$triggerId')({
	component: TriggerDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggerDetailPage() {
	const { triggerId } = Route.useParams()
	const { workspaceId, workspace } = useWorkspace()
	const { data: trigger, isLoading, error } = useTrigger(triggerId, workspaceId)
	const { data: actors } = useActors(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const deleteTrigger = useDeleteTrigger(workspaceId)
	const navigate = useNavigate()

	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	if (isLoading) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (error || !trigger) {
		return (
			<div className="flex items-center justify-center py-16">
				<p className="text-sm text-muted-foreground">{error?.message || 'Trigger not found'}</p>
			</div>
		)
	}

	const handleUpdate = (payload: TriggerFormPayload) => {
		updateTrigger.mutate({
			id: trigger.id,
			data: {
				name: payload.name,
				action_prompt: payload.action_prompt,
				target_actor_id: payload.target_actor_id,
				config: payload.config as never,
			},
		})
	}

	const handleDelete = () => {
		deleteTrigger.mutate(trigger.id, {
			onSuccess: () => {
				navigate({
					to: '/$workspaceId/triggers',
					params: { workspaceId },
					search: { create: false },
				})
			},
		})
	}

	const handleToggleEnabled = () => {
		updateTrigger.mutate({ id: trigger.id, data: { enabled: !trigger.enabled } })
	}

	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto">
				<TriggerForm
					workspaceId={workspaceId}
					workspace={workspace}
					agents={agents}
					initialValues={trigger}
					onSubmit={handleUpdate}
					onDelete={handleDelete}
					onToggleEnabled={handleToggleEnabled}
					submitLabel="Save"
					isPending={updateTrigger.isPending}
					error={updateTrigger.error}
				/>
			</div>
		</>
	)
}
