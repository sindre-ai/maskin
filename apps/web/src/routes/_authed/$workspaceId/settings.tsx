import { PageHeader } from '@/components/layout/page-header'
import { LegacySettingsNav } from '@/components/settings/legacy/settings-nav'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
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
	{ label: 'Billing', to: '/$workspaceId/settings/billing' as const },
]

// Keys is listed only for workspaces holding the `byollm_allowed` ops grant —
// for everyone else the page has no content to show. It stays a real route
// regardless, because onboarding and `session-errors.ts` both deep-link it.
const keysNavItem = {
	label: 'Keys',
	to: '/$workspaceId/settings/keys' as const,
	exact: false,
}

function SettingsLayoutV2() {
	const { workspace, workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const navItems = workspace?.byollmAllowed ? [...settingsNav, keysNavItem] : settingsNav

	return (
		<div className="mx-auto w-full max-w-6xl">
			{/* The screen's <h1> belongs to the shared top nav (mockup 155–279), not
			    the page body — PageHeader publishes it and renders nothing here. */}
			<PageHeader title="Settings" subtitle={workspace?.name} />
			<div className="flex flex-col gap-6 md:flex-row md:gap-8">
				<nav
					aria-label="Settings sections"
					className="md:w-[172px] md:shrink-0 md:border-r md:border-border md:pr-2"
				>
					<ul className="flex gap-0.5 overflow-x-auto pb-2 md:flex-col md:pb-0">
						{navItems.map((item) => {
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

// `new-design` boundary for the Settings shell: the v2 six-section nav above,
// or the pre-v2 nav under `components/settings/legacy/`.
function SettingsLayout() {
	return useFeatureFlag('new-design') ? <SettingsLayoutV2 /> : <LegacySettingsNav />
}
