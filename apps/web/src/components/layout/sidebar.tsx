import { UnreadBadge } from '@/components/shared/unread-badge'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarRail,
	SidebarTrigger,
} from '@/components/ui/sidebar'
import { useChatUnreadCount } from '@/hooks/use-chat-unread'
import { useUnread } from '@/hooks/use-subscriptions'
import {
	CHATS_ROUTE,
	CORE_NAV_ITEMS,
	FOR_YOU_ROUTE,
	type NavItemDef,
	OBJECTS_NAV_ITEM,
	useHasObjectsNavItem,
} from '@/lib/nav-items'
import { useWorkspace } from '@/lib/workspace-context'
import { Store } from 'lucide-react'
import { useMemo } from 'react'
import { NavUser } from './nav-user'
import { SidebarActivity } from './sidebar-activity'
import { SidebarNavItem } from './sidebar-nav-item'
import { WorkspaceSwitcher } from './workspace-switcher'

// `navSecondaryDefs` (Marketplace) from the mockup. Agents and Triggers are
// deliberately absent: Agents is reached through the working-agents card in
// the footer, triggers through the "Not tied to a loop" group on Loops. Both
// routes stay mounted, so deep links and bookmarks keep resolving.
const marketplaceItem: NavItemDef = {
	key: 'marketplace',
	label: 'Marketplace',
	to: '/$workspaceId/marketplace',
	icon: Store,
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId } = useWorkspace()
	const hasObjectTypes = useHasObjectsNavItem()
	const { data: unread } = useUnread(workspaceId)
	const unreadCount = unread?.items.length ?? 0
	const chatUnread = useChatUnreadCount(workspaceId)

	const navItems = useMemo(
		() => (hasObjectTypes ? [...CORE_NAV_ITEMS, OBJECTS_NAV_ITEM] : CORE_NAV_ITEMS),
		[hasObjectTypes],
	)

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader className="h-11 justify-center">
				{/* v2 pairs the workspace name with an explicit collapse control
				    (mockup line 62). SidebarRail still handles the drag edge; this
				    is the discoverable affordance. It has no place on the rail
				    itself — there the workspace tile expands the sidebar. */}
				<div className="flex items-center gap-1">
					<div className="min-w-0 flex-1">
						<WorkspaceSwitcher />
					</div>
					{/* Named for what it does here, not the generic primitive label —
					    the SidebarRail is also in the tree and also toggles, and two
					    controls sharing one accessible name is ambiguous to a screen
					    reader (and to any role-based query). */}
					<SidebarTrigger
						aria-label="Collapse sidebar"
						title="Collapse sidebar"
						className="size-7 shrink-0 text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:hidden"
					/>
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{navItems.map((item) => (
							<SidebarNavItem key={item.to} item={item} source="top-nav">
								{item.to === FOR_YOU_ROUTE && (
									<>
										<UnreadBadge
											count={unreadCount}
											variant="plain"
											className="ml-auto group-data-[collapsible=icon]:hidden"
										/>
										<CollapsedUnreadDot count={unreadCount} />
									</>
								)}
								{item.to === CHATS_ROUTE && (
									<UnreadBadge
										count={chatUnread.count}
										overflow={chatUnread.hasMore}
										variant="plain"
										className="ml-auto group-data-[collapsible=icon]:hidden"
									/>
								)}
							</SidebarNavItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
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

// The icon rail has no room for a numeral, so unread collapses to a 6px brand
// dot on the tile (mockup line 125's `i.dot`). Scoped to For you: the mockup
// gives the rail exactly one attention signal, and putting it on Chats too
// makes neither mean anything. Hidden when the sidebar is expanded, where the
// numeral carries the same signal with more precision.
function CollapsedUnreadDot({ count }: { count: number }) {
	if (count <= 0) return null
	return (
		<span
			aria-hidden="true"
			className="absolute right-1 top-1 hidden size-1.5 rounded-full bg-brand group-data-[collapsible=icon]:block"
		/>
	)
}
