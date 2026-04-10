import { CommandPalette } from '@/components/command-palette'
import { Header } from '@/components/layout/header'
import { AppSidebar } from '@/components/layout/sidebar'
import { RouteError } from '@/components/shared/route-error'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useSSE } from '@/hooks/use-sse'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { PageHeaderProvider } from '@/lib/page-header-context'
import { WorkspaceContext } from '@/lib/workspace-context'
import { Navigate, Outlet, createFileRoute, useMatchRoute } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'

const STORAGE_KEY = 'maskin-sidebar-open'

// Migrate old key
try {
	const old = localStorage.getItem('ai-native-sidebar-open')
	if (old && !localStorage.getItem(STORAGE_KEY)) {
		localStorage.setItem(STORAGE_KEY, old)
		localStorage.removeItem('ai-native-sidebar-open')
	}
} catch {}

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

	const matchRoute = useMatchRoute()
	const isOnboardingRoute = matchRoute({
		to: '/$workspaceId/onboarding',
		params: { workspaceId },
	})

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

	// Redirect to onboarding only when explicitly marked as not completed (false).
	// Using strict equality avoids redirecting existing workspaces where the field
	// is undefined (predating this feature).
	const settings = workspace.settings as Record<string, unknown> | undefined
	if (settings?.onboarding_completed === false && !isOnboardingRoute) {
		return <Navigate to="/$workspaceId/onboarding" params={{ workspaceId }} />
	}

	// If on onboarding page, render without sidebar/header chrome
	if (isOnboardingRoute) {
		return (
			<WorkspaceContext.Provider value={{ workspace, workspaceId, sseStatus }}>
				<Outlet />
			</WorkspaceContext.Provider>
		)
	}

	return (
		<WorkspaceContext.Provider value={{ workspace, workspaceId, sseStatus }}>
			<PageHeaderProvider>
				<SidebarProvider open={open} onOpenChange={setOpen} className="h-screen !min-h-0">
					<AppSidebar />
					<SidebarInset className="min-w-0">
						<Header />
						<div className="flex flex-col flex-1 overflow-auto p-8">
							<Outlet />
						</div>
					</SidebarInset>
				</SidebarProvider>
			</PageHeaderProvider>
			<CommandPalette />
		</WorkspaceContext.Provider>
	)
}
