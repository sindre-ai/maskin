import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { Layers, type LucideIcon, MessageSquare, RefreshCw, Zap } from 'lucide-react'
import { useMemo } from 'react'

export interface NavItemDef {
	key: string
	label: string
	to: string
	icon: LucideIcon
	exact?: boolean
}

export const FOR_YOU_ROUTE = '/$workspaceId' as const
export const CHATS_ROUTE = '/$workspaceId/chats' as const

// v2 nav inventory rendered by the sidebar, which becomes an off-canvas drawer
// below 768px — mockup `navDefs` (For you, Chats, Loops, Objects). `key` is the
// stable analytics identifier for `nav_item_clicked` — never rename after ship
// without coordinating with the PostHog query in the parent bet
// (`metadata.posthog_query`).
export const CORE_NAV_ITEMS: NavItemDef[] = [
	{ key: 'for-you', label: 'For you', to: FOR_YOU_ROUTE, exact: true, icon: Zap },
	{ key: 'chats', label: 'Chats', to: CHATS_ROUTE, icon: MessageSquare },
	{ key: 'loops', label: 'Loops', to: '/$workspaceId/loops', icon: RefreshCw },
]

export const OBJECTS_NAV_ITEM: NavItemDef = {
	key: 'objects',
	label: 'Objects',
	to: '/$workspaceId/objects',
	icon: Layers,
}

// Objects only earns a nav slot once the workspace has object types to show.
export function useHasObjectsNavItem(): boolean {
	const enabledModules = useEnabledModules()
	return useMemo(() => getEnabledObjectTypeTabs(enabledModules).length > 0, [enabledModules])
}
