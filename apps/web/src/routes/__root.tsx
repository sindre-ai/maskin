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
				toastOptions={{
					style: {
						background: 'var(--ui-card)',
						border: '1px solid var(--clr-border)',
						color: 'var(--clr-text)',
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
