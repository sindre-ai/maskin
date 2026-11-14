import { isAuthenticated } from '@/lib/auth'
import { hasCachedFlags, loadFeatureFlags } from '@/lib/feature-flags'
import { safeInternalPath } from '@/lib/safe-redirect'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed')({
	beforeLoad: async ({ location }) => {
		if (!isAuthenticated()) {
			// Remember the page they wanted so the login page can send them back after sign-in.
			const target = safeInternalPath(location.href)
			throw redirect({
				to: '/login',
				search: target && target !== '/' ? { redirect: target } : {},
			})
		}
		// Stale-while-revalidate: block only on the very first load, when there is
		// nothing cached to render from. That first load may briefly show the
		// pre-flag UI; every later navigation renders instantly from the cache and
		// revalidates behind it, so there is no flash on repeat visits.
		if (hasCachedFlags()) void loadFeatureFlags()
		else await loadFeatureFlags()
	},
	component: () => <Outlet />,
})
