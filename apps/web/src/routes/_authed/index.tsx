import { Skeleton } from '@/components/shared/loading-skeleton'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/')({
	component: IndexRedirect,
})

function IndexRedirect() {
	const { data: workspaces, isLoading } = useWorkspaces()

	if (isLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<Skeleton className="h-8 w-48" />
			</div>
		)
	}

	if (workspaces?.length === 1) {
		return <Navigate to="/$workspaceId" params={{ workspaceId: workspaces[0].id }} />
	}

	return <Navigate to="/workspaces" />
}
