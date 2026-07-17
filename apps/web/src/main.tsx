import '@/lib/extensions'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app.css'
import { initBackNavTracker } from './lib/back-nav-tracker'
import { consumeMagicLink } from './lib/magic-link'
import { initPosthog } from './lib/posthog'
import { queryClient } from './lib/query'
import { ThemeProvider } from './lib/theme'
import { routeTree } from './routeTree.gen'

// Consume any #key=... fragment before the router mounts so the auth guard sees the key.
consumeMagicLink()
initPosthog()
// Attach the popstate listener at app boot, before any route module loads —
// otherwise a deep-link start (e.g. `/objects/{id}` from a Slack link) followed
// by a browser back to the list would fire popstate before the objects route
// module ran, and the back-nav landing would go uncounted.
initBackNavTracker()

const router = createRouter({
	routeTree,
	context: { queryClient },
	defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}

// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed to exist in index.html
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</ThemeProvider>
	</StrictMode>,
)
