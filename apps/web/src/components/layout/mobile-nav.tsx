import { useSidebar } from '@/components/ui/sidebar'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { trackNavItemClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Link, useMatchRoute, useRouterState } from '@tanstack/react-router'
import { Layers, MessageSquare, MoreHorizontal, RefreshCw, Zap } from 'lucide-react'
import { useMemo } from 'react'

// On mobile (≤767px) the sidebar becomes an off-canvas sheet, so the fixed bottom
// bar is the primary navigation rail. Item keys mirror the desktop sidebar's
// stable analytics identifiers so `nav_item_clicked` stays comparable across
// surfaces. Static bar (no entrance animation) makes it trivially safe under
// prefers-reduced-motion.
const FOR_YOU_ROUTE = '/$workspaceId' as const

interface MobileNavItem {
	key: string
	label: string
	to: string
	icon: typeof Zap
	exact?: boolean
}

// Order: For you, Chats, Flows, Items. Mirrors the v2 sidebar inventory (mockup navDefs). Agents is deliberately not
// here — it is reached through the working-agents card and agent-name links, and
// a bottom bar promoting it would reinstate exactly the entry the sidebar drops.
const baseItems: MobileNavItem[] = [
	{ key: 'for-you', label: 'For you', to: FOR_YOU_ROUTE, exact: true, icon: Zap },
	{ key: 'chats', label: 'Chats', to: '/$workspaceId/chats', icon: MessageSquare },
	{ key: 'loops', label: 'Flows', to: '/$workspaceId/loops', icon: RefreshCw },
]

// The bar only shows on list pages. Screens that own a bottom composer or are full-screen
// detail pages (an open chat, an item, a flow, an agent, a session, a file, settings, search)
// hide it so it never collides with a composer or an action bar.
const LIST_SEGMENTS = new Set(['chats', 'loops', 'objects', 'agents', 'marketplace'])

export function showsMobileNav(pathname: string, workspaceId: string): boolean {
	const prefix = `/${workspaceId}`
	if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false
	const segments = pathname.slice(prefix.length).split('/').filter(Boolean)
	if (segments.length === 0) return true
	return segments.length === 1 && LIST_SEGMENTS.has(segments[0] as string)
}

export function MobileNav() {
	const { workspaceId } = useWorkspace()
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const { setOpenMobile } = useSidebar()
	const enabledModules = useEnabledModules()
	const matchRoute = useMatchRoute()

	const items = useMemo(() => {
		const hasObjectTypes = getEnabledObjectTypeTabs(enabledModules).length > 0
		if (!hasObjectTypes) return baseItems
		const objectsItem: MobileNavItem = {
			key: 'objects',
			label: 'Items',
			to: '/$workspaceId/objects',
			icon: Layers,
		}
		return [...baseItems, objectsItem]
	}, [enabledModules])

	if (!showsMobileNav(pathname, workspaceId)) return null

	return (
		<nav
			aria-label="Primary"
			data-testid="mobile-nav"
			className="shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
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
								'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[11px] font-medium transition-colors duration-150',
								isActive ? 'text-foreground' : 'text-muted-foreground',
							)}
						>
							<Icon size={18} aria-hidden />
							<span className="leading-none">{item.label}</span>
						</Link>
					)
				})}
				<button
					type="button"
					onClick={() => setOpenMobile(true)}
					aria-label="More"
					className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150"
				>
					<MoreHorizontal size={18} aria-hidden />
					<span className="leading-none">More</span>
				</button>
			</div>
		</nav>
	)
}
