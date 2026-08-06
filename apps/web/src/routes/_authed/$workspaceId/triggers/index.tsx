import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { useActors } from '@/hooks/use-actors'
import { useTriggers } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggersPage() {
	const { workspaceId } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const [createPickerOpen, setCreatePickerOpen] = useState(false)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	return (
		<div>
			<PageHeader title="Triggers" />

			{isLoading ? (
				<ListSkeleton />
			) : !triggers?.length ? (
				<EmptyState
					title="No triggers yet"
					description="Triggers automate your workspace by running agents in response to events, schedules, or one-time reminders. Create your first trigger to get started."
				/>
			) : (
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground mb-3">
						Triggers automatically run agents when events happen, on a schedule, or at a specific
						time.
					</p>
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
				</div>
			)}
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="trigger"
			/>
		</div>
	)
}
