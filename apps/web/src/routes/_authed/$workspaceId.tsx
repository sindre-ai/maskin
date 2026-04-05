import { CommandPalette } from '@/components/command-palette'
import { Header } from '@/components/layout/header'
import { AppSidebar } from '@/components/layout/sidebar'
import { RouteError } from '@/components/shared/route-error'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useSSE } from '@/hooks/use-sse'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { PageHeaderProvider } from '@/lib/page-header-context'
import { WorkspaceContext } from '@/lib/workspace-context'
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'

const STORAGE_KEY = 'ai-native-sidebar-open'

function getInitialOpen(): boolean {
	try {
		const stored = localStorage.getItem(STORAGE_KEY)
		return stored === null ? true : stored === 'true'
	} catch {
		return true
	}
}

export const Route = createFileRoute('/_authed/$workspaceId')({
	component: WorkspaceLayout,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WorkspaceLayout() {
	const { workspaceId } = Route.useParams()
	const { data: workspaces } = useWorkspaces()

	// Connect SSE for real-time updates
	const sseStatus = useSSE(workspaceId)

	const workspace = useMemo(
		() => workspaces?.find((w) => w.id === workspaceId),
		[workspaces, workspaceId],
	)

	const [open, setOpenState] = useState(getInitialOpen)

	const setOpen = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
		setOpenState((prev) => {
			const next = typeof value === 'function' ? value(prev) : value
			localStorage.setItem(STORAGE_KEY, String(next))
			return next
		})
	}, [])

	if (!workspace) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<p className="text-sm text-muted-foreground">Loading workspace...</p>
			</div>
		)
	}

	return (
		<WorkspaceContext.Provider value={{ workspace, workspaceId, sseStatus }}>
			<PageHeaderProvider>
				<SidebarProvider open={open} onOpenChange={setOpen} className="h-screen !min-h-0">
					<AppSidebar />
					<SidebarInset className="min-w-0">
						<Header />
						<div className="flex-1 overflow-auto p-4 md:p-8">
							<Outlet />
						</div>
					</SidebarInset>
				</SidebarProvider>
			</PageHeaderProvider>
			<CommandPalette />
		</WorkspaceContext.Provider>
	)
}
