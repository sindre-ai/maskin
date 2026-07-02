import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, Outlet, createFileRoute, useMatchRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings')({
	component: SettingsLayout,
})

const settingsNav = [
	{ label: 'General', to: '/$workspaceId/settings' as const, exact: true },
	{ label: 'Objects', to: '/$workspaceId/settings/objects' as const },
	{ label: 'Members', to: '/$workspaceId/settings/members' as const },
	{ label: 'Integrations', to: '/$workspaceId/settings/integrations' as const },
	{ label: 'Skills', to: '/$workspaceId/settings/skills' as const },
	{ label: 'LLM', to: '/$workspaceId/settings/keys' as const },
	{ label: 'MCP', to: '/$workspaceId/settings/mcp' as const },
]

function SettingsLayout() {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()

	return (
		<div className="mx-auto w-full max-w-4xl">
			<h1 className="text-title font-semibold text-foreground mb-[var(--space-6)]">Settings</h1>
			<div className="flex flex-col md:flex-row gap-[var(--space-6)] md:gap-[var(--space-7)]">
				<nav className="md:w-48 md:shrink-0">
					<ul className="flex md:flex-col gap-[2px] overflow-x-auto pb-[var(--space-2)] md:pb-[0]">
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
											'block whitespace-nowrap rounded-md px-[var(--space-3)] py-[6px] text-label transition-colors',
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
