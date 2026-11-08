import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { type NavItemSource, trackNavItemClicked } from '@/lib/analytics'
import type { NavItemDef } from '@/lib/nav-items'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useMatchRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

interface SidebarNavItemProps {
	item: NavItemDef
	source: NavItemSource
	// Route params beyond the workspace id (e.g. a dynamic `fileId` for the
	// files viewer route). Merged over the workspace id on both match and link.
	params?: Record<string, string>
	children?: ReactNode
}

// The Link and useMatchRoute generics require literal route strings; NavItemDef
// carries `to: string` so a single component can render every nav entry regardless of
// route, so the router options are cast at the call site. TanStack Router validates the
// path at runtime — passing an unknown route still fails loudly, just not at compile time.
export function SidebarNavItem({ item, source, params = {}, children }: SidebarNavItemProps) {
	const { workspaceId } = useWorkspace()
	const matchRoute = useMatchRoute()
	const { setOpenMobile } = useSidebar()
	const Icon = item.icon
	const routeParams = { workspaceId, ...params }

	const isActive = !!matchRoute({
		to: item.to,
		params: routeParams,
		fuzzy: !item.exact,
	} as never)

	return (
		<SidebarMenuItem>
			<SidebarMenuButton
				asChild
				isActive={isActive}
				tooltip={item.label}
				// v11 row: 36px, 13.5px label, 17px icon, 9px radius. Resting rows read
				// in the secondary ink; the active row is solid ink on the accent fill.
				className="h-9 gap-2.5 rounded-[9px] px-2.5 text-[13.5px] font-medium text-muted-foreground data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-[17px]"
			>
				{item.href ? (
					<a
						href={item.href}
						target="_blank"
						rel="noopener noreferrer"
						onClick={() => trackNavItemClicked({ item_key: item.key, source })}
					>
						<Icon />
						<span>{item.label}</span>
						{children}
					</a>
				) : (
					<Link
						to={item.to as never}
						params={routeParams as never}
						search={{} as never}
						onClick={() => {
							trackNavItemClicked({ item_key: item.key, source })
							setOpenMobile(false)
						}}
					>
						<Icon />
						<span>{item.label}</span>
						{children}
					</Link>
				)}
			</SidebarMenuButton>
		</SidebarMenuItem>
	)
}
