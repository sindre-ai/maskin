import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerForm } from '@/components/triggers/trigger-form'
import type { TriggerFormPayload } from '@/components/triggers/trigger-form'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import {
	useCreateTrigger,
	useDeleteTrigger,
	useTrigger,
	useUpdateTrigger,
} from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/$triggerId')({
	component: TriggerDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggerDetailPage() {
	const { triggerId } = Route.useParams()
	const { workspaceId, workspace } = useWorkspace()
	const { data: trigger, isLoading } = useTrigger(triggerId, workspaceId)
	const { data: actors } = useActors(workspaceId)
	const createTrigger = useCreateTrigger(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const deleteTrigger = useDeleteTrigger(workspaceId)
	const navigate = useNavigate()
	const isCreatedRef = useRef(false)

	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	// Once the trigger exists in cache, mark as created
	useEffect(() => {
		if (trigger) isCreatedRef.current = true
	}, [trigger])
	const isCreated = isCreatedRef.current || !!trigger

	if (isLoading && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	const handleAutoCreate = async (payload: TriggerFormPayload) => {
		if (isCreatedRef.current) return
		isCreatedRef.current = true
		try {
			await createTrigger.mutateAsync({
				id: triggerId,
				name: payload.name,
				type: payload.type,
				action_prompt: payload.action_prompt,
				target_actor_id: payload.target_actor_id,
				config: payload.config as never,
				enabled: payload.enabled,
			})
			toast.success('Trigger created')
		} catch {
			isCreatedRef.current = false
		}
	}

	const handleSave = (payload: TriggerFormPayload) => {
		updateTrigger.mutate({
			id: triggerId,
			data: {
				name: payload.name,
				action_prompt: payload.action_prompt,
				target_actor_id: payload.target_actor_id,
				config: payload.config as never,
			},
		})
	}

	const handleDelete = () => {
		deleteTrigger.mutate(triggerId, {
			onSuccess: () => {
				navigate({
					to: '/$workspaceId/triggers',
					params: { workspaceId },
				})
			},
		})
	}

	const handleToggleEnabled = () => {
		if (!trigger) return
		updateTrigger.mutate({ id: triggerId, data: { enabled: !trigger.enabled } })
	}

	return (
		<>
			<PageHeader
				actions={
					isCreated ? (
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-muted-foreground hover:text-error"
							onClick={handleDelete}
						>
							<Trash2 size={15} />
						</Button>
					) : undefined
				}
			/>
			<div className="max-w-3xl mx-auto">
				<TriggerForm
					workspaceId={workspaceId}
					workspace={workspace}
					agents={agents}
					initialValues={trigger}
					onAutoCreate={!isCreated ? handleAutoCreate : undefined}
					onSave={isCreated ? handleSave : undefined}
					onToggleEnabled={isCreated ? handleToggleEnabled : undefined}
					isPending={createTrigger.isPending || updateTrigger.isPending}
					error={createTrigger.error || updateTrigger.error}
					isCreated={isCreated}
				/>
			</div>
		</>
	)
}
