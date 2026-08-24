import { trackNavItemClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { CORE_NAV_ITEMS, OBJECTS_NAV_ITEM, useHasObjectsNavItem } from '@/lib/nav-items'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { useMemo } from 'react'

// On mobile (≤767px) the sidebar becomes an off-canvas sheet, so the fixed bottom
// bar is the primary navigation rail. Item keys mirror the desktop sidebar's
// stable analytics identifiers so `nav_item_clicked` stays comparable across
// surfaces. Static bar (no entrance animation) makes it trivially safe under
// prefers-reduced-motion.
//
// Agents is deliberately not here — it is reached through the working-agents
// card and agent-name links, and a bottom bar promoting it would reinstate
// exactly the entry the sidebar drops. Unlike the sidebar (which appends
// Objects last), the bottom bar puts it right after For You — the mockup's
// bottom-bar ordering promotes Objects above Chats/Loops on mobile.
export function MobileNav() {
	const { workspaceId } = useWorkspace()
	const hasObjectTypes = useHasObjectsNavItem()
	const matchRoute = useMatchRoute()

	const items = useMemo(() => {
		if (!hasObjectTypes) return CORE_NAV_ITEMS
		const [forYou, ...rest] = CORE_NAV_ITEMS
		return [forYou, OBJECTS_NAV_ITEM, ...rest]
	}, [hasObjectTypes])

	return (
		<nav
			aria-label="Primary"
			className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
		>
			<div className="flex items-stretch justify-around">
				{items.map((item) => {
					const Icon = item.icon
					const isActive = !!matchRoute({
						to: item.to,
						params: { workspaceId },
						fuzzy: !item.exact,
					} as never)
					return (
						<Link
							key={item.key}
							to={item.to as never}
							params={{ workspaceId } as never}
							search={{} as never}
							onClick={() => trackNavItemClicked({ item_key: item.key, source: 'bottom-nav' })}
							aria-label={`${item.label}, ${isActive ? 'current page' : 'navigate to'}`}
							className={cn(
								'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors duration-150',
								isActive ? 'text-foreground' : 'text-muted-foreground',
							)}
						>
							<Icon size={18} aria-hidden />
							<span className="leading-none">{item.label}</span>
						</Link>
					)
				})}
			</div>
		</nav>
	)
}
