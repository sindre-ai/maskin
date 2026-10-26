import { isAuthenticated } from '@/lib/auth'
import { hasCachedFlags, loadFeatureFlags } from '@/lib/feature-flags'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed')({
	beforeLoad: async () => {
		if (!isAuthenticated()) {
			throw redirect({ to: '/login' })
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
