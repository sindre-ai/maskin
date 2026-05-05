import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/work/')({
	component: WorkBoardPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WorkBoardPage() {
	const { workspaceId } = useWorkspace()

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<PageHeader title="Work" />
			<EmptyState
				title="Work board (coming soon)"
				description={`The Kanban board for workspace ${workspaceId} will live here. Bet swimlanes, status columns, and cards where humans and agents are equal teammates.`}
			/>
		</div>
	)
}
