import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { trackNavItemClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Bot, Layers, RefreshCw, Zap } from 'lucide-react'
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

const baseItems: MobileNavItem[] = [
	{ key: 'for-you', label: 'For You', to: FOR_YOU_ROUTE, exact: true, icon: Zap },
	{ key: 'agents', label: 'Agents', to: '/$workspaceId/agents', icon: Bot },
	{ key: 'loops', label: 'Loops', to: '/$workspaceId/loops', icon: RefreshCw },
	{ key: 'triggers', label: 'Triggers', to: '/$workspaceId/triggers', icon: Zap },
]

export function MobileNav() {
	const { workspaceId } = useWorkspace()
	const enabledModules = useEnabledModules()
	const matchRoute = useMatchRoute()

	const items = useMemo(() => {
		const hasObjectTypes = getEnabledObjectTypeTabs(enabledModules).length > 0
		if (!hasObjectTypes) return baseItems
		const objectsItem: MobileNavItem = {
			key: 'objects',
			label: 'Objects',
			to: '/$workspaceId/objects',
			icon: Layers,
		}
		const [forYou, ...rest] = baseItems
		return [forYou, objectsItem, ...rest]
	}, [enabledModules])

	return (
		<nav
			aria-label="Primary"
			className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden pb-[env(safe-area-inset-bottom)]"
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
