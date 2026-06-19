import { Skeleton } from '@/components/shared/loading-skeleton'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { Link, Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/workspaces')({
	component: WorkspacePicker,
})

function WorkspacePicker() {
	const { data: workspaces, isLoading } = useWorkspaces()

	if (isLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<Skeleton className="h-8 w-48" />
			</div>
		)
	}

	// Authenticated users with no workspaces have nothing to access
	if (workspaces?.length === 0) {
		return <Navigate to="/signup" />
	}

	// Defensive guard for direct navigation: IndexRedirect normally skips /workspaces
	// for single-workspace users, but someone can arrive here directly via URL or link
	if (workspaces?.length === 1) {
		return <Navigate to="/$workspaceId" params={{ workspaceId: workspaces[0].id }} />
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Choose workspace</h1>
				</div>
				<div className="space-y-2">
					{workspaces?.map((ws) => (
						<Link
							key={ws.id}
							to="/$workspaceId"
							params={{ workspaceId: ws.id }}
							className="block rounded-lg border border-border bg-card p-4 hover:bg-muted transition-all"
						>
							<p className="text-sm font-medium text-foreground">{ws.name}</p>
							<p className="text-xs text-muted-foreground mt-1">Role: {ws.role}</p>
						</Link>
					))}
				</div>
			</div>
		</div>
	)
}
