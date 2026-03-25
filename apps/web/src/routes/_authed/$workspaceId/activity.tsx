import { ActivityFeed } from '@/components/activity/activity-feed'
import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/activity')({
	component: ActivityPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ActivityPage() {
	const { workspaceId } = useWorkspace()

	return (
		<div>
			<PageHeader title="Activity" />
			<ActivityFeed workspaceId={workspaceId} />
		</div>
	)
}
