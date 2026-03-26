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
	SidebarTrigger,
} from '@/components/ui/sidebar'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledNavItems, getEnabledObjectTypeTabs } from '@ai-native/module-sdk'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Activity, Bot, CheckSquare, Layers, Lightbulb, Target, Video, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { AgentPulse } from '../agents/agent-pulse'
import { NavUser } from './nav-user'

/** Map of icon names to Lucide components */
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
	layers: Layers,
	lightbulb: Lightbulb,
	target: Target,
	'check-square': CheckSquare,
	activity: Activity,
	bot: Bot,
	zap: Zap,
	video: Video,
}

/** Core nav items that are always shown regardless of modules */
const coreNavItems = [
	{ label: 'Pulse', to: '/$workspaceId' as const, exact: true, icon: Zap },
	{ label: 'Activity', to: '/$workspaceId/activity' as const, icon: Activity },
	{ label: 'Agents', to: '/$workspaceId/agents' as const, icon: Bot },
	{ label: 'Triggers', to: '/$workspaceId/triggers' as const, icon: Zap },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId, workspace } = useWorkspace()
	const matchRoute = useMatchRoute()

	const settings = workspace.settings as Record<string, unknown>
	const enabledModulesRaw = (settings?.enabled_modules as string[]) ?? ['work']
	// biome-ignore lint/correctness/useExhaustiveDependencies: stabilize array reference from JSONB
	const enabledModules = useMemo(() => enabledModulesRaw, [JSON.stringify(enabledModulesRaw)])

	// Get module nav items and convert to sidebar format
	const moduleNavItems = useMemo(() => {
		const items = getEnabledNavItems(enabledModules)
		return items.map((item) => ({
			label: item.label,
			to: `/$workspaceId/${item.path}` as const,
			icon: iconMap[item.icon] ?? Layers,
			exact: item.exact,
		}))
	}, [enabledModules])

	const objectTypeTabs = useMemo(() => getEnabledObjectTypeTabs(enabledModules), [enabledModules])

	// Build nav: Pulse, Objects (if any types enabled), module custom nav, then core rest
	const allNavItems = useMemo(() => {
		const [pulse, ...restCore] = coreNavItems
		const objectsNav =
			objectTypeTabs.length > 0
				? [{ label: 'Objects', to: '/$workspaceId/objects' as const, icon: Layers }]
				: []
		return [pulse, ...objectsNav, ...moduleNavItems, ...restCore]
	}, [moduleNavItems, objectTypeTabs])

	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader className="h-16 justify-center">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarTrigger />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{allNavItems.map((item) => {
							const Icon = item.icon
							const isActive = !!matchRoute({
								to: item.to as string,
								params: { workspaceId },
								fuzzy: !('exact' in item && item.exact),
							})

							return (
								<SidebarMenuItem key={item.to}>
									<SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
										<Link to={item.to as string} params={{ workspaceId }}>
											<Icon />
											<span>{item.label}</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							)
						})}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<div className="px-2 group-data-[collapsible=icon]:hidden">
					<AgentPulse workspaceId={workspaceId} />
				</div>
				<NavUser />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	)
}
