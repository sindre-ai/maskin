import { OfflineBanner } from '@/components/shared/offline-banner'
import { RouteError } from '@/components/shared/route-error'
import { useTheme } from '@/lib/theme'
import type { QueryClient } from '@tanstack/react-query'
import { HeadContent, Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { Toaster } from 'sonner'

interface RouterContext {
	queryClient: QueryClient
}

function RootComponent() {
	const { resolvedTheme } = useTheme()

	return (
		// `min-h-dvh`, not `min-h-screen` (100vh): on iOS Safari 100vh is the
		// largest viewport height (URL bar collapsed) and stays that size while
		// the URL bar is visible, so the document ends up taller than the
		// visible viewport by the URL-bar height. That extra height renders as
		// a strip of `bg-background` white below the shell, makes every page
		// scrollable, and takes the sticky header down with it when the user
		// scrolls. Same reason `SidebarProvider` was flipped to `h-dvh` in
		// #1659 — this is the outer container that leaked past that fix on
		// small mobile because it still measured against 100vh.
		<div className="min-h-dvh bg-background text-foreground">
			<HeadContent />
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
		<div className="min-h-dvh bg-background text-foreground flex items-center justify-center">
			<RouteError error={error} />
		</div>
	),
})
