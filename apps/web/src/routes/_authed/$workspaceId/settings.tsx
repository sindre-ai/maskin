import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, Outlet, createFileRoute, useMatchRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings')({
	component: SettingsLayout,
})

const settingsNav = [
	{ label: 'General', to: '/$workspaceId/settings' as const, exact: true },
	{ label: 'Keys', to: '/$workspaceId/settings/keys' as const },
	{ label: 'Members', to: '/$workspaceId/settings/members' as const },
	{ label: 'Properties', to: '/$workspaceId/settings/properties' as const },
	{ label: 'Integrations', to: '/$workspaceId/settings/integrations' as const },
	{ label: 'MCP', to: '/$workspaceId/settings/mcp' as const },
]

function SettingsLayout() {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()

	return (
		<div className="mx-auto w-full max-w-4xl">
			<h1 className="text-lg font-semibold text-foreground mb-6">Settings</h1>
			<div className="flex flex-col md:flex-row gap-6 md:gap-8">
				<nav className="md:w-48 md:shrink-0">
					<ul className="flex md:flex-col gap-0.5 overflow-x-auto pb-2 md:pb-0">
						{settingsNav.map((item) => {
							const isActive = item.exact
								? !!matchRoute({ to: item.to, params: { workspaceId } })
								: !!matchRoute({ to: item.to, params: { workspaceId }, fuzzy: true })
							return (
								<li key={item.to}>
									<Link
										to={item.to}
										params={{ workspaceId }}
										className={cn(
											'block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
											isActive
												? 'bg-muted font-medium text-foreground'
												: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
										)}
									>
										{item.label}
									</Link>
								</li>
							)
						})}
					</ul>
				</nav>
				<div className="flex-1 min-w-0">
					<Outlet />
				</div>
			</div>
		</div>
	)
}
