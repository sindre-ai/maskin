import { isAuthenticated } from '@/lib/auth'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed')({
	beforeLoad: () => {
		if (!isAuthenticated()) {
			throw redirect({ to: '/login' })
		}
	},
	component: () => <Outlet />,
})
