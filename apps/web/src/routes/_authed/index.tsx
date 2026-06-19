import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/')({
	component: () => <Navigate to="/workspaces" />,
})
