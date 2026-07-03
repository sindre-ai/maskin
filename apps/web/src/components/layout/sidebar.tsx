import { UnreadBadge } from '@/components/shared/unread-badge'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from '@/components/ui/sidebar'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUnread } from '@/hooks/use-subscriptions'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Activity, Bot, Layers, Store, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { NavUser } from './nav-user'
import { SidebarActivity } from './sidebar-activity'
import { WorkspaceSwitcher } from './workspace-switcher'

const FOR_YOU_ROUTE = '/$workspaceId' as const

const coreNavItems = [
	{ label: 'For You', to: FOR_YOU_ROUTE, exact: true, icon: Zap },
	{ label: 'Activity', to: '/$workspaceId/activity' as const, icon: Activity },
	{ label: 'Agents', to: '/$workspaceId/agents' as const, icon: Bot },
	{ label: 'Triggers', to: '/$workspaceId/triggers' as const, icon: Zap },
	{ label: 'Marketplace', to: '/$workspaceId/marketplace' as const, icon: Store },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const { setOpenMobile } = useSidebar()
	const enabledModules = useEnabledModules()
	const { data: unread } = useUnread(workspaceId)
	const unreadCount = unread?.items.length ?? 0

	const navItems = useMemo(() => {
		const hasObjectTypes = getEnabledObjectTypeTabs(enabledModules).length > 0
		const [pulse, ...rest] = coreNavItems
		const objectsItem = hasObjectTypes
			? [{ label: 'Objects', to: '/$workspaceId/objects' as const, icon: Layers }]
			: []
		return [pulse, ...objectsItem, ...rest]
	}, [enabledModules])

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader className="h-11 justify-center">
				<WorkspaceSwitcher />
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{navItems.map((item) => {
							const Icon = item.icon
							const isActive = !!matchRoute({
								to: item.to,
								params: { workspaceId },
								fuzzy: !('exact' in item),
							})

							return (
								<SidebarMenuItem key={item.to}>
									<SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
										<Link
											to={item.to}
											params={{ workspaceId }}
											search={{}}
											onClick={() => setOpenMobile(false)}
										>
											<Icon />
											<span>{item.label}</span>
											{item.to === FOR_YOU_ROUTE && (
												<UnreadBadge
													count={unreadCount}
													className="ml-auto group-data-[collapsible=icon]:hidden"
												/>
											)}
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							)
						})}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarActivity workspaceId={workspaceId} />
				<NavUser />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	)
}
