import { AgentsIndexView } from '@/components/agents/agents-index-view'
import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/agents/')({
	component: AgentsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function AgentsPage() {
	const { workspaceId } = useWorkspace()
	const { data: actors, isLoading } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId, { paged: true })
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

	const agents = useMemo(() => (actors ?? []).filter((a) => a.type === 'agent'), [actors])

	if (isLoading) {
		return (
			<div>
				<PageHeader title="Agents" />
				<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
					<CardSkeleton />
					<CardSkeleton />
					<CardSkeleton />
				</div>
				<CreatePicker
					open={createPickerOpen}
					onOpenChange={setCreatePickerOpen}
					defaultType="agent"
				/>
			</div>
		)
	}

	return (
		<div>
			<PageHeader title="Agents" />

			{agents.length === 0 ? (
				<EmptyState
					title="No agents in this workspace"
					description="Create an agent to get started with automation"
				/>
			) : (
				<AgentsIndexView workspaceId={workspaceId} agents={agents} sessions={sessions ?? []} />
			)}
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="agent"
			/>
		</div>
	)
}
