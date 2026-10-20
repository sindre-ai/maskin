import { CreateFirstWorkspace } from '@/components/layout/create-first-workspace'
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

	// A signed-in account with no workspaces (e.g. it deleted its last one) must
	// not be sent to /signup, which would create a new actor. Let it create one.
	if (!workspaces?.length) {
		return <CreateFirstWorkspace />
	}

	// Land on the last workspace the user opened. The remembered id is only
	// trusted while the user is still a member; otherwise fall back to the first.
	const lastId = getLastWorkspaceId()
	const target = workspaces.find((w) => w.id === lastId) ?? workspaces[0]

	return <Navigate to="/$workspaceId" params={{ workspaceId: target.id }} />
}
