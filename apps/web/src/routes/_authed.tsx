import { isAuthenticated } from '@/lib/auth'
import { initPosthog } from '@/lib/posthog'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed')({
	beforeLoad: () => {
		if (!isAuthenticated()) {
			throw redirect({ to: '/login' })
		}
		// Belt-and-braces: `initPosthog()` also runs at app boot (main.tsx). The
		// guard inside makes this idempotent and cheap — it ensures the SDK is
		// initialised no later than the moment the user reaches any authed
		// surface, matching the For You briefing bet's activation gate.
		initPosthog()
	},
	component: () => <Outlet />,
})
