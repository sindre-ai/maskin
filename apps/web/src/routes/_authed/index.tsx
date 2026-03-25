import { Skeleton } from '@/components/shared/loading-skeleton'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/')({
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

	// If only one workspace, redirect to it
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
						<a
							key={ws.id}
							href={`/${ws.id}`}
							className="block rounded-lg border border-border bg-card p-4 hover:border-border hover:bg-muted/30 transition-all"
						>
							<p className="text-sm font-medium text-foreground">{ws.name}</p>
							<p className="text-xs text-muted-foreground mt-1">Role: {ws.role}</p>
						</a>
					))}
				</div>
			</div>
		</div>
	)
}
