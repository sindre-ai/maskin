import { UnreadBadge } from '@/components/shared/unread-badge'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarRail,
} from '@/components/ui/sidebar'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUnread } from '@/hooks/use-subscriptions'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Bot, Layers, RefreshCw, Store, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { NavUser } from './nav-user'
import { SidebarActivity } from './sidebar-activity'
import { SidebarFavorites } from './sidebar-favorites'
import { SidebarNavItem, type SidebarNavItemDef } from './sidebar-nav-item'
import { WorkspaceSwitcher } from './workspace-switcher'

const FOR_YOU_ROUTE = '/$workspaceId' as const

// `key` is the stable analytics identifier for `nav_item_clicked` — never rename
// after ship without coordinating with the PostHog query in the parent bet
// (`metadata.posthog_query`).
const coreNavItems: SidebarNavItemDef[] = [
	{ key: 'for-you', label: 'For You', to: FOR_YOU_ROUTE, exact: true, icon: Zap },
	{ key: 'agents', label: 'Agents', to: '/$workspaceId/agents', icon: Bot },
	{ key: 'loops', label: 'Loops', to: '/$workspaceId/loops', icon: RefreshCw },
	{ key: 'triggers', label: 'Triggers', to: '/$workspaceId/triggers', icon: Zap },
]

const marketplaceItem: SidebarNavItemDef = {
	key: 'marketplace',
	label: 'Marketplace',
	to: '/$workspaceId/marketplace',
	icon: Store,
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId } = useWorkspace()
	const enabledModules = useEnabledModules()
	const { data: unread } = useUnread(workspaceId)
	const unreadCount = unread?.items.length ?? 0

	const navItems = useMemo(() => {
		const hasObjectTypes = getEnabledObjectTypeTabs(enabledModules).length > 0
		const [pulse, ...rest] = coreNavItems
		const objectsItem: SidebarNavItemDef[] = hasObjectTypes
			? [{ key: 'objects', label: 'Objects', to: '/$workspaceId/objects', icon: Layers }]
			: []
		return [pulse, ...objectsItem, ...rest]
	}, [enabledModules])

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader className="min-h-11 justify-center">
				<WorkspaceSwitcher />
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{navItems.map((item) => (
							<SidebarNavItem key={item.to} item={item} source="top-nav">
								{item.to === FOR_YOU_ROUTE && (
									<UnreadBadge
										count={unreadCount}
										className="ml-auto group-data-[collapsible=icon]:hidden"
									/>
								)}
							</SidebarNavItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
				<SidebarFavorites />
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarNavItem item={marketplaceItem} source="footer" />
				</SidebarMenu>
				<SidebarActivity workspaceId={workspaceId} />
				<NavUser />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	)
}
