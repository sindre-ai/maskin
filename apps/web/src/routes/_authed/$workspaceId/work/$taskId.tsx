import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/work/$taskId')({
	component: WorkTaskDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WorkTaskDetailPage() {
	const { taskId } = Route.useParams()

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<PageHeader title="Work" />
			<EmptyState
				title="Task detail (coming soon)"
				description={`The full-page detail view for task ${taskId} will live here.`}
			/>
		</div>
	)
}
