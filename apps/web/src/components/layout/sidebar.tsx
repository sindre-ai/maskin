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
	useSidebar,
} from '@/components/ui/sidebar'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@ai-native/module-sdk'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { Activity, Bot, Layers, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { AgentPulse } from '../agents/agent-pulse'
import { NavUser } from './nav-user'

const coreNavItems = [
	{ label: 'Pulse', to: '/$workspaceId' as const, exact: true, icon: Zap },
	{ label: 'Activity', to: '/$workspaceId/activity' as const, icon: Activity },
	{ label: 'Agents', to: '/$workspaceId/agents' as const, icon: Bot },
	{ label: 'Triggers', to: '/$workspaceId/triggers' as const, icon: Zap },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	const { workspaceId, workspace } = useWorkspace()
	const matchRoute = useMatchRoute()
	const { setOpenMobile } = useSidebar()

	const settings = workspace.settings as Record<string, unknown>
	const enabledModules = (settings?.enabled_modules as string[]) ?? ['work']

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
											onClick={() => setOpenMobile(false)}
										>
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
