import { isAuthenticated } from '@/lib/auth'
import { hasCachedFlags, loadFeatureFlags, setFlagsWorkspace } from '@/lib/feature-flags'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const Route = createFileRoute('/_authed')({
	beforeLoad: async ({ location }) => {
		if (!isAuthenticated()) {
			throw redirect({ to: '/login' })
		}
		// Workspace routes live under /$workspaceId, so the first path segment names the
		// workspace whose workspace-scoped flags the answer should cover. Anywhere else
		// the answer is the actor-only one.
		const firstSegment = location.pathname.split('/')[1] ?? ''
		setFlagsWorkspace(UUID_RE.test(firstSegment) ? firstSegment : null)
		// Stale-while-revalidate: block only on the very first load, when there is
		// nothing cached to render from. That first load may briefly show the
		// pre-flag UI; every later navigation renders instantly from the cache and
		// revalidates behind it, so there is no flash on repeat visits.
		if (hasCachedFlags()) void loadFeatureFlags()
		else await loadFeatureFlags()
	},
	component: () => <Outlet />,
})
