import { PageHeader } from '@/components/layout/page-header'
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
	{ label: 'Extensions', to: '/$workspaceId/settings/extensions' as const },
	{ label: 'Skills', to: '/$workspaceId/settings/skills' as const },
	{ label: 'Billing', to: '/$workspaceId/settings/billing' as const },
	{ label: 'LLM', to: '/$workspaceId/settings/keys' as const },
	{ label: 'MCP', to: '/$workspaceId/settings/mcp' as const },
]

function SettingsLayout() {
	const { workspace, workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()

	return (
		<div className="mx-auto w-full max-w-6xl">
			{/* The screen's <h1> belongs to the shared top nav (mockup 155–279), not
			    the page body — PageHeader publishes it and renders nothing here. */}
			<PageHeader title="Settings" subtitle={workspace?.name} />
			<div className="flex flex-col gap-6 md:flex-row md:gap-8">
				<nav className="md:w-[172px] md:shrink-0 md:border-r md:border-border md:pr-2">
					<ul className="flex gap-0.5 overflow-x-auto pb-2 md:flex-col md:pb-0">
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
											'block whitespace-nowrap rounded-md px-3 py-2 text-[12.5px] transition-colors',
											isActive
												? 'bg-muted font-bold text-foreground'
												: 'font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
										)}
									>
										{item.label}
									</Link>
								</li>
							)
						})}
					</ul>
				</nav>
				<div className="min-w-0 flex-1">
					<Outlet />
				</div>
			</div>
		</div>
	)
}
