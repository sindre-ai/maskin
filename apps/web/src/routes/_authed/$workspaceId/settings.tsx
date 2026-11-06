import { PageHeader } from '@/components/layout/page-header'
import { SettingsPageTitle } from '@/components/settings/settings-page-title'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, Outlet, createFileRoute, useMatchRoute } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings')({
	component: SettingsLayout,
})

interface SettingsNavItem {
	label: string
	to:
		| '/$workspaceId/settings'
		| '/$workspaceId/settings/objects'
		| '/$workspaceId/settings/members'
		| '/$workspaceId/settings/integrations'
		| '/$workspaceId/settings/extensions'
		| '/$workspaceId/settings/skills'
		| '/$workspaceId/settings/mcp'
		| '/$workspaceId/settings/billing'
		| '/$workspaceId/settings/notifications'
		| '/$workspaceId/settings/keys'
		| '/$workspaceId/settings/keychain'
	exact?: boolean
}

// Grouped as in the v11 mockup: what belongs to the workspace, what shapes the
// agents, and how access is granted.
const WORKSPACE_NAV: SettingsNavItem[] = [
	{ label: 'General', to: '/$workspaceId/settings', exact: true },
	{ label: 'Members', to: '/$workspaceId/settings/members' },
	{ label: 'Integrations', to: '/$workspaceId/settings/integrations' },
	{ label: 'Billing', to: '/$workspaceId/settings/billing' },
	{ label: 'Notifications', to: '/$workspaceId/settings/notifications' },
]
const AGENTS_NAV: SettingsNavItem[] = [
	{ label: 'Skills', to: '/$workspaceId/settings/skills' },
	{ label: 'Item types', to: '/$workspaceId/settings/objects' },
]
const ACCESS_NAV: SettingsNavItem[] = [{ label: 'Keys and MCP', to: '/$workspaceId/settings/mcp' }]

// Keys is listed only for workspaces holding the `byollm_allowed` ops grant —
// for everyone else the page has no content to show. It stays a real route
// regardless, because onboarding and the failed-session card both deep-link it.
const keysNavItem: SettingsNavItem = { label: 'Keys', to: '/$workspaceId/settings/keys' }

// Keychain is listed only while its flag is on. The Keychain routes read the flag
// themselves, so a typed-in URL answers not found when it is off.
const keychainNavItem: SettingsNavItem = {
	label: 'Keychain',
	to: '/$workspaceId/settings/keychain',
}

function SettingsLayout() {
	useDocumentTitle('Settings')
	const { workspace, workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const isGeneral = !!matchRoute({ to: '/$workspaceId/settings', params: { workspaceId } })
	const groups: { label: string; items: SettingsNavItem[] }[] = [
		{ label: 'Workspace', items: WORKSPACE_NAV },
		{ label: 'Agents', items: AGENTS_NAV },
		{
			label: 'Access',
			items: [...ACCESS_NAV, keychainNavItem, ...(workspace?.enterprise ? [keysNavItem] : [])],
		},
	]
	const isItemActive = (item: SettingsNavItem) =>
		item.exact
			? !!matchRoute({ to: item.to, params: { workspaceId } })
			: !!matchRoute({ to: item.to, params: { workspaceId }, fuzzy: true })
	const activeTo = groups.flatMap((group) => group.items).find(isItemActive)?.to
	const activeRef = useRef<HTMLAnchorElement>(null)

	// On a narrow screen the nav is a scrolling strip; keep the active item in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active item changes
	useEffect(() => {
		activeRef.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
	}, [activeTo])

	return (
		<div className="mx-auto w-full max-w-6xl">
			{/* The screen's <h1> belongs to the shared top nav, not the page body. */}
			{/* On a sub-page the crumb leaf is the page's own label (Settings › Integrations); a
			    "Settings" title here would name the leaf "Settings" a second time. */}
			<PageHeader title={isGeneral ? 'Settings' : undefined} hideTitle={isGeneral} />
			<div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-4 md:grid-cols-[200px_minmax(0,1fr)]">
				<nav aria-label="Settings sections" className="min-w-0 md:col-start-1 md:pt-1">
					<div className="flex gap-4 overflow-x-auto pb-2 md:flex-col md:gap-5 md:pb-0">
						{groups.map((group) => (
							<div key={group.label} className="flex shrink-0 flex-col gap-0.5 md:shrink">
								<div className="px-3 pb-1 text-xs font-semibold text-muted-foreground">
									{group.label}
								</div>
								<ul className="flex gap-0.5 md:flex-col">
									{group.items.map((item) => {
										const isActive = item.to === activeTo
										return (
											<li key={item.to}>
												<Link
													to={item.to}
													params={{ workspaceId }}
													className={cn(
														'block whitespace-nowrap rounded-[10px] px-3 py-2 text-sm transition-colors max-md:flex max-md:min-h-11 max-md:items-center',
														isActive
															? 'bg-secondary font-bold text-foreground'
															: 'font-medium text-muted-foreground hover:bg-secondary hover:text-foreground',
													)}
												>
													{item.label}
												</Link>
											</li>
										)
									})}
								</ul>
							</div>
						))}
					</div>
				</nav>
				<div className="min-w-0 md:col-start-2">
					{isGeneral && <SettingsPageTitle title="Settings" />}
					<Outlet />
				</div>
			</div>
		</div>
	)
}
