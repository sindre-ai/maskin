import { Skeleton } from '@/components/shared/loading-skeleton'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { getLastWorkspaceId } from '@/lib/last-workspace'
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

	// Authenticated users with no workspaces have nothing to access
	if (!workspaces?.length) {
		return <Navigate to="/signup" />
	}

	// Land on the last workspace the user opened. The remembered id is only
	// trusted while the user is still a member; otherwise fall back to the first.
	const lastId = getLastWorkspaceId()
	const target = workspaces.find((w) => w.id === lastId) ?? workspaces[0]

	return <Navigate to="/$workspaceId" params={{ workspaceId: target.id }} />
}
