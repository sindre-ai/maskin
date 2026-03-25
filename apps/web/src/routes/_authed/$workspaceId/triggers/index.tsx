import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerForm } from '@/components/triggers/trigger-form'
import type { TriggerFormPayload } from '@/components/triggers/trigger-form'
import { useActors } from '@/hooks/use-actors'
import { useCreateTrigger, useTriggers } from '@/hooks/use-triggers'
import type { TriggerResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === 'true' || search.create === true,
	}),
})

function TriggersPage() {
	const { workspaceId, workspace } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const createTrigger = useCreateTrigger(workspaceId)
	const navigate = useNavigate()
	const { create } = useSearch({ from: '/_authed/$workspaceId/triggers/' })
	const [showCreate, setShowCreate] = useState(false)

	useEffect(() => {
		if (create) setShowCreate(true)
	}, [create])

	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	const handleCreate = async (payload: TriggerFormPayload) => {
		try {
			const result = await createTrigger.mutateAsync({
				name: payload.name,
				type: payload.type,
				action_prompt: payload.action_prompt,
				target_actor_id: payload.target_actor_id,
				config: payload.config as never,
			})
			setShowCreate(false)
			navigate({
				to: '/$workspaceId/triggers/$triggerId',
				params: { workspaceId, triggerId: result.id },
			})
		} catch {
			// error accessible via createTrigger.error
		}
	}

	return (
		<div>
			<PageHeader title="Triggers" />

			{showCreate && (
				<div className="mb-6 rounded-lg border border-border bg-card p-4">
					<TriggerForm
						workspaceId={workspaceId}
						workspace={workspace}
						agents={agents}
						onSubmit={handleCreate}
						onCancel={() => setShowCreate(false)}
						submitLabel="Create"
						isPending={createTrigger.isPending}
						error={createTrigger.error}
					/>
				</div>
			)}

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
			className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-muted/50 transition-colors"
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
