import '@/lib/extensions'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app.css'
import { consumeMagicLink } from './lib/magic-link'
import { queryClient } from './lib/query'
import { ThemeProvider } from './lib/theme'
import { routeTree } from './routeTree.gen'

// Consume any #key=... fragment before the router mounts so the auth guard sees the key.
consumeMagicLink()

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
