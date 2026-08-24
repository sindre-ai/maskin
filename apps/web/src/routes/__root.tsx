import { OfflineBanner } from '@/components/shared/offline-banner'
import { RouteError } from '@/components/shared/route-error'
import { useTheme } from '@/lib/theme'
import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { Toaster } from 'sonner'

interface RouterContext {
	queryClient: QueryClient
}

function RootComponent() {
	const { resolvedTheme } = useTheme()

	return (
		<div className="min-h-screen bg-background text-foreground">
			<OfflineBanner />
			<Outlet />
			<Toaster
				theme={resolvedTheme}
				position="bottom-right"
				// Every Radix-based overlay (Sheet, Dialog, DropdownMenu, Popover,
				// Select, Tooltip) uses Tailwind's z-50. Toasts must always be
				// visible above whichever of those is open — e.g. the session
				// detail drawer on the agents page — so this needs to clear all
				// of them, not tie with them (a tie is resolved by DOM/portal
				// order, which isn't guaranteed to favor the toaster).
				style={{ zIndex: 100 }}
				toastOptions={{
					style: {
						background: 'var(--popover)',
						border: '1px solid var(--border)',
						color: 'var(--popover-foreground)',
					},
				}}
			/>
		</div>
	)
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootComponent,
	errorComponent: ({ error }) => (
		<div className="min-h-screen bg-background text-foreground flex items-center justify-center">
			<RouteError error={error} />
		</div>
	),
})
